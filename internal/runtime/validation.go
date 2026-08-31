package runtime

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	readyLine              = regexp.MustCompile(`^dsh web: (http://127\.0\.0\.1:[0-9]{1,5}/\?token=[A-Za-z0-9_-]{43})$`)
	readyToken             = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	bootManifestAssignment = regexp.MustCompile(`(?s)(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*(\{.*?\})\s*</script>`)
)

const clientModulesPackage = "@deepseek-ai/dsh-client-modules"

type bootManifest struct {
	Entries []struct {
		ID string `json:"id"`
	} `json:"entries"`
	Batches []struct {
		Phase   string   `json:"phase"`
		URL     string   `json:"url"`
		Entries []string `json:"entries"`
	} `json:"batches"`
}

func parseBootManifest(body []byte) (bootManifest, error) {
	match := bootManifestAssignment.FindSubmatch(body)
	if len(match) != 2 {
		return bootManifest{}, fmt.Errorf("homepage is missing the Harness boot manifest")
	}
	var manifest bootManifest
	if err := json.Unmarshal(match[1], &manifest); err != nil {
		return bootManifest{}, fmt.Errorf("decode Harness boot manifest: %w", err)
	}
	return manifest, nil
}

func bootstrapBundle(manifest bootManifest) (string, error) {
	hasClientModules := false
	for _, entry := range manifest.Entries {
		if entry.ID == clientModulesPackage {
			hasClientModules = true
			break
		}
	}
	if !hasClientModules {
		return "", fmt.Errorf("Harness boot manifest is missing %s", clientModulesPackage)
	}
	for _, batch := range manifest.Batches {
		if batch.Phase != "bootstrap" || batch.URL == "" {
			continue
		}
		for _, entry := range batch.Entries {
			if entry == clientModulesPackage {
				return batch.URL, nil
			}
		}
	}
	return "", fmt.Errorf("Harness boot manifest did not preload %s", clientModulesPackage)
}

func ParseReadyLine(line string) (string, bool) {
	m := readyLine.FindStringSubmatch(line)
	if len(m) != 2 {
		return "", false
	}
	if err := ValidateLoopbackURL(m[1]); err != nil {
		return "", false
	}
	return m[1], true
}

func ValidateLoopbackURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "http" || u.User != nil || u.Opaque != "" || u.Path != "/" || u.RawPath != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" {
		return fmt.Errorf("unexpected Harness URL shape")
	}
	host, port, err := net.SplitHostPort(u.Host)
	if err != nil || host != "127.0.0.1" || port == "" {
		return fmt.Errorf("Harness URL is not IPv4 loopback")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("invalid Harness port")
	}
	const tokenPrefix = "token="
	if !strings.HasPrefix(u.RawQuery, tokenPrefix) || !readyToken.MatchString(strings.TrimPrefix(u.RawQuery, tokenPrefix)) {
		return fmt.Errorf("invalid Harness launch token")
	}
	return nil
}

func ProbeBootManifest(client *http.Client, raw string, timeout time.Duration) error {
	if err := ValidateLoopbackURL(raw); err != nil {
		return err
	}
	expected, _ := url.Parse(raw)
	if client == nil {
		client = &http.Client{}
	}
	probeClient := *client
	jar, err := cookiejar.New(nil)
	if err != nil {
		return fmt.Errorf("create Harness probe cookie jar: %w", err)
	}
	probeClient.Jar = jar
	probeClient.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) != 1 || req.Response == nil || req.Response.StatusCode != http.StatusSeeOther {
			return fmt.Errorf("unexpected Harness authentication redirect")
		}
		u := req.URL
		if u.Scheme != expected.Scheme || u.Host != expected.Host || u.User != nil || u.Opaque != "" || u.Path != "/" || u.RawPath != "" || u.ForceQuery || u.RawQuery != "" || u.Fragment != "" || u.RawFragment != "" {
			return fmt.Errorf("unsafe Harness authentication redirect")
		}
		return nil
	}
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		resp, err := probeClient.Get(raw)
		if err == nil {
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
			_ = resp.Body.Close()
			sameOrigin := resp.Request != nil && resp.Request.URL.Scheme == expected.Scheme && resp.Request.URL.Host == expected.Host && resp.Request.URL.Path == "/" && resp.Request.URL.RawQuery == "" && resp.Request.URL.Fragment == ""
			if readErr == nil && sameOrigin && resp.StatusCode >= 200 && resp.StatusCode < 300 {
				manifest, manifestErr := parseBootManifest(body)
				bootstrapPath, bootstrapErr := bootstrapBundle(manifest)
				if manifestErr == nil && bootstrapErr == nil {
					bootstrapRef, parseErr := url.Parse(bootstrapPath)
					if parseErr == nil {
						bootstrapURL := expected.ResolveReference(bootstrapRef)
						if bootstrapURL.Scheme == expected.Scheme && bootstrapURL.Host == expected.Host && bootstrapURL.User == nil && strings.HasPrefix(bootstrapURL.Path, "/plugins/") {
							bundleResp, bundleErr := probeClient.Get(bootstrapURL.String())
							if bundleErr == nil {
								bundleBody, bundleReadErr := io.ReadAll(io.LimitReader(bundleResp.Body, 2<<20))
								_ = bundleResp.Body.Close()
								if bundleReadErr == nil && bundleResp.StatusCode == http.StatusOK && strings.Contains(string(bundleBody), clientModulesPackage) {
									return nil
								}
								if bundleReadErr != nil {
									last = bundleReadErr
								} else {
									last = fmt.Errorf("Harness client-modules bootstrap failed validation (status %d)", bundleResp.StatusCode)
								}
							} else {
								last = bundleErr
							}
						} else {
							last = fmt.Errorf("unsafe Harness bootstrap bundle URL")
						}
					} else {
						last = parseErr
					}
				} else if manifestErr != nil {
					last = manifestErr
				} else {
					last = bootstrapErr
				}
			}
			if readErr != nil {
				last = readErr
			} else if last == nil {
				last = fmt.Errorf("homepage failed same-origin boot validation (status %d)", resp.StatusCode)
			}
		} else {
			last = err
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("Harness boot manifest probe failed: %w", last)
}
