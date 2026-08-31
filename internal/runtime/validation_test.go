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
	valid := "http://127.0.0.1:43127/?token=" + strings.Repeat("A", 43)
	if got, ok := ParseReadyLine("dsh web: " + valid); !ok || got != valid {
		t.Fatalf("ready line rejected: %q %v", got, ok)
	}
	bad := []string{
		"dsh web: http://127.0.0.1:43127",
		"dsh web: http://localhost:43127/?token=" + strings.Repeat("A", 43),
		"dsh web: http://127.0.0.1:0/?token=" + strings.Repeat("A", 43),
		"prefix dsh web: " + valid,
		"dsh web: https://127.0.0.1:43127/?token=" + strings.Repeat("A", 43),
		"dsh web: http://127.0.0.1:43127/path?token=" + strings.Repeat("A", 43),
		"dsh web: http://127.0.0.1:43127/?token=" + strings.Repeat("A", 42),
		"dsh web: " + valid + "&extra=1",
		"dsh web: " + valid + "&token=" + strings.Repeat("B", 43),
		"dsh web: " + valid + "#fragment",
	}
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

func TestHarnessLaunchArgsDisableBrowser(t *testing.T) {
	got := strings.Join(harnessLaunchArgs("file:///child-control.mjs", "C:/runtime/apps/cli/lib/bin.js"), " ")
	want := "--import file:///child-control.mjs C:/runtime/apps/cli/lib/bin.js --profile web --no-open --host 127.0.0.1 --port 0"
	if got != want {
		t.Fatalf("unexpected Harness launch arguments:\n got: %s\nwant: %s", got, want)
	}
}

func TestProbeBootManifest(t *testing.T) {
	graph := `{"entries":[{"id":"@deepseek-ai/dsh-client-modules"}],"batches":[{"phase":"bootstrap","url":"/plugins/bootstrap.js","entries":["@deepseek-ai/dsh-client-modules"]}]}`
	for _, manifest := range []string{
		`window.__DSH_BOOT__=` + graph,
		`globalThis["__DSH_BOOT__"] = ` + graph,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.RawQuery == "token="+strings.Repeat("A", 43) {
				http.SetCookie(w, &http.Cookie{Name: "dsh-auth-test", Value: "valid", Path: "/", HttpOnly: true})
				http.Redirect(w, r, "/", http.StatusSeeOther)
				return
			}
			cookie, err := r.Cookie("dsh-auth-test")
			if err != nil || cookie.Value != "valid" || r.URL.RawQuery != "" {
				http.Error(w, "authentication required", http.StatusUnauthorized)
				return
			}
			if r.URL.Path == "/plugins/bootstrap.js" {
				_, _ = w.Write([]byte(`window.__ModuleLoader__.load({id:"@deepseek-ai/dsh-client-modules"})`))
				return
			}
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(`<script>` + manifest + `</script>`))
		}))
		raw := strings.Replace(server.URL, "localhost", "127.0.0.1", 1) + "/?token=" + strings.Repeat("A", 43)
		if err := ProbeBootManifest(server.Client(), raw, time.Second); err != nil {
			server.Close()
			t.Fatalf("manifest %q was rejected: %v", manifest, err)
		}
		server.Close()
	}
}

func TestProbeBootManifestRejectsEmptyGraph(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery == "token="+strings.Repeat("A", 43) {
			http.SetCookie(w, &http.Cookie{Name: "dsh-auth-test", Value: "valid", Path: "/", HttpOnly: true})
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		_, _ = w.Write([]byte(`<script>globalThis["__DSH_BOOT__"] = {"entries":[],"batches":[]}</script>`))
	}))
	defer server.Close()
	raw := strings.Replace(server.URL, "localhost", "127.0.0.1", 1) + "/?token=" + strings.Repeat("A", 43)
	if err := ProbeBootManifest(server.Client(), raw, 250*time.Millisecond); err == nil {
		t.Fatal("accepted an empty Harness boot graph")
	}
}

func TestProbeBootManifestRejectsCrossOriginRedirect(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<script>window.__DSH_BOOT__={}</script>`))
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusSeeOther)
	}))
	defer server.Close()
	raw := strings.Replace(server.URL, "localhost", "127.0.0.1", 1) + "/?token=" + strings.Repeat("A", 43)
	if err := ProbeBootManifest(server.Client(), raw, 250*time.Millisecond); err == nil {
		t.Fatal("accepted cross-origin authentication redirect")
	}
}
