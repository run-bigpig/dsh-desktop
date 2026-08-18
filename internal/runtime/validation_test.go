package runtime

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReadyLineAndLoopbackValidation(t *testing.T) {
	valid := "http://127.0.0.1:43127"
	if got, ok := ParseReadyLine("dsh web: " + valid); !ok || got != valid {
		t.Fatalf("ready line rejected: %q %v", got, ok)
	}
	bad := []string{"dsh web: http://localhost:12", "dsh web: http://127.0.0.1:0", "prefix dsh web: " + valid, "dsh web: https://127.0.0.1:9", "dsh web: http://127.0.0.1:9/path"}
	for _, line := range bad {
		if _, ok := ParseReadyLine(line); ok {
			t.Fatalf("accepted unsafe ready line %q", line)
		}
	}
}

func TestNodeImportSpecifierIsFileURL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "child control.mjs")
	got, err := nodeImportSpecifier(path)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "file" || !strings.HasPrefix(got, "file:///") {
		t.Fatalf("expected an absolute file URL, got %q", got)
	}
	if strings.Contains(got, " ") {
		t.Fatalf("file URL did not escape spaces: %q", got)
	}
}

func TestProbeBootManifest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<script>window.__DSH_BOOT__={}</script>`))
	}))
	defer server.Close()
	raw := strings.Replace(server.URL, "localhost", "127.0.0.1", 1)
	if err := ProbeBootManifest(server.Client(), raw, time.Second); err != nil {
		t.Fatal(err)
	}
}
