package runtime

import (
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
	readyLine  = regexp.MustCompile(`^dsh web: (http://127\.0\.0\.1:[0-9]{1,5}/\?token=[A-Za-z0-9_-]{43})$`)
	readyToken = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

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
			hasBootManifest := strings.Contains(string(body), "window.__DSH_BOOT__") ||
				strings.Contains(string(body), `globalThis["__DSH_BOOT__"]`)
			if readErr == nil && sameOrigin && resp.StatusCode >= 200 && resp.StatusCode < 300 && hasBootManifest {
				return nil
			}
			if readErr != nil {
				last = readErr
			} else {
				last = fmt.Errorf("homepage failed same-origin boot validation (status %d)", resp.StatusCode)
			}
		} else {
			last = err
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("Harness boot manifest probe failed: %w", last)
}
