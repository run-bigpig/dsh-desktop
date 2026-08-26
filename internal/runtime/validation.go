package runtime

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var readyLine = regexp.MustCompile(`^dsh web: (http://127\.0\.0\.1:[0-9]{1,5})\s*$`)

func ParseReadyLine(line string) (string, bool) {
	m := readyLine.FindStringSubmatch(strings.TrimSpace(line))
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
	if u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("unexpected Harness URL shape")
	}
	host, port, err := net.SplitHostPort(u.Host)
	if err != nil || host != "127.0.0.1" || port == "" {
		return fmt.Errorf("Harness URL is not IPv4 loopback")
	}
	n, err := net.LookupPort("tcp", port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("invalid Harness port")
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
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		resp, err := client.Get(raw)
		if err == nil {
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
			_ = resp.Body.Close()
			sameOrigin := resp.Request != nil && resp.Request.URL.Scheme == expected.Scheme && resp.Request.URL.Host == expected.Host
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
