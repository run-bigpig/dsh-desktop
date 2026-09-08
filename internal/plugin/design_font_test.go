package plugin

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDesignFontCapabilityIsIsolated(t *testing.T) {
	b := &Bridge{token: "control-secret", fontToken: "font-secret", fontOrigin: "http://127.0.0.1:1234"}
	for _, tc := range []struct {
		method, origin, token string
		status                int
	}{
		{"GET", "http://evil.example", "font-secret", 403},
		{"GET", "http://127.0.0.1:1235", "font-secret", 403},
		{"GET", "", "font-secret", 403},
		{"GET", b.fontOrigin, "control-secret", 401},
		{"GET", b.fontOrigin, "", 401},
		{"POST", b.fontOrigin, "font-secret", 405},
		{"OPTIONS", b.fontOrigin, "", 204},
	} {
		r := httptest.NewRequest(tc.method, "/v1/design/font", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Authorization", "Bearer "+tc.token)
		w := httptest.NewRecorder()
		b.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Errorf("%s %s: got %d, want %d", tc.method, tc.origin, w.Code, tc.status)
		}
		if tc.origin != b.fontOrigin && w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("CORS exposed to another origin")
		}
	}
	r := httptest.NewRequest("GET", "/v1/window/state", nil)
	r.Header.Set("Authorization", "Bearer font-secret")
	w := httptest.NewRecorder()
	b.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("font token must not authorize desktop control")
	}
}

func TestDesignFontReadsOnlyFixedSystemFont(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows system font")
	}
	root := t.TempDir()
	t.Setenv("WINDIR", root)
	if err := os.Mkdir(filepath.Join(root, "Fonts"), 0700); err != nil {
		t.Fatal(err)
	}
	b := &Bridge{fontToken: "font-secret", fontOrigin: "http://127.0.0.1:1234"}
	request := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/v1/design/font?path=../secret", nil)
		r.Header.Set("Origin", b.fontOrigin)
		r.Header.Set("Authorization", "Bearer font-secret")
		w := httptest.NewRecorder()
		b.ServeHTTP(w, r)
		return w
	}
	if w := request(); w.Code != 404 {
		t.Fatalf("missing font: %d", w.Code)
	}
	if err := os.WriteFile(filepath.Join(root, "Fonts", "simhei.ttf"), []byte("fixed-font"), 0600); err != nil {
		t.Fatal(err)
	}
	w := request()
	if w.Code != 200 || w.Body.String() != "fixed-font" || w.Header().Get("Content-Type") != "font/ttf" {
		t.Fatalf("font response: %d %q", w.Code, w.Body.String())
	}
}

func TestDesignFontInjectionGuardsOriginAndRefreshesPort(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows injection")
	}
	b := &Bridge{url: "http://127.0.0.1:4321/", token: "control-secret", fontToken: "font-secret"}
	for _, invalid := range []string{"https://example.com", "http://localhost:1234", "http://127.0.0.1", "http://127.0.0.1:99999", "http://user@127.0.0.1:1234"} {
		if _, err := b.DesignFontScript(invalid); err == nil {
			t.Errorf("accepted %s", invalid)
		}
	}
	script, err := b.DesignFontScript("http://127.0.0.1:1234/?token=private")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(script, "control-secret") || strings.Contains(script, "private") || !strings.Contains(script, "location.origin !== config.origin") {
		t.Fatal("invalid injection scope")
	}
	if _, err := b.DesignFontScript("http://127.0.0.1:5678/"); err != nil {
		t.Fatal(err)
	}
	if b.fontOrigin != "http://127.0.0.1:5678" {
		t.Fatal("stale Harness origin after restart")
	}
}
