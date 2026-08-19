package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/buildinfo"
	"github.com/run-bigpig/dsh-desktop/internal/state"
)

func TestCheckAndDownloadDesktopRelease(t *testing.T) {
	payload := []byte("fixture desktop installer")
	digest := sha256.Sum256(payload)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/latest":
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"tag_name": "v0.2.0",
				"html_url": server.URL + "/release",
				"body":     "release notes",
				"assets": []map[string]any{{
					"name": buildinfo.WindowsX64Asset, "browser_download_url": server.URL + "/installer",
					"digest": "sha256:" + hex.EncodeToString(digest[:]), "size": len(payload),
				}},
			})
		case "/installer":
			_, _ = writer.Write(payload)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store := state.NewStore(paths.State)
	manager := New(paths, store, "0.1.0", server.URL+"/latest", server.Client())
	update, err := manager.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if update == nil || update.Version != "0.2.0" {
		t.Fatalf("unexpected update: %#v", update)
	}
	installer, err := manager.Download(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(installer)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("downloaded installer mismatch: %q", got)
	}
	if store.Snapshot().Phase != state.Installing {
		t.Fatalf("unexpected phase %q", store.Snapshot().Phase)
	}
}

func TestCheckUsesChecksumSidecar(t *testing.T) {
	digest := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/latest":
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"tag_name": "v1.0.0",
				"assets": []map[string]any{
					{"name": buildinfo.WindowsX64Asset, "browser_download_url": server.URL + "/installer", "size": 10},
					{"name": buildinfo.WindowsX64Asset + ".sha256", "browser_download_url": server.URL + "/checksum"},
				},
			})
		case "/checksum":
			_, _ = writer.Write([]byte(digest + "  " + buildinfo.WindowsX64Asset))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	manager := New(paths, state.NewStore(paths.State), "0.2.0", server.URL+"/latest", server.Client())
	update, err := manager.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if update.SHA256 != digest {
		t.Fatalf("checksum = %q", update.SHA256)
	}
}

func TestCheckReportsCurrentVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(writer).Encode(map[string]any{"tag_name": "v0.2.0", "assets": []any{}})
	}))
	defer server.Close()
	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store := state.NewStore(paths.State)
	manager := New(paths, store, "0.2.0", server.URL, server.Client())
	update, err := manager.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if update != nil || store.Snapshot().AvailableUpdate != nil {
		t.Fatal("current release was incorrectly reported as an update")
	}
}

func TestSemanticVersionComparison(t *testing.T) {
	tests := []struct {
		candidate string
		current   string
		want      bool
	}{{"0.2.0", "0.1.9", true}, {"1.0.0", "0.9.9", true}, {"1.0.0-beta.2", "1.0.0-beta.1", true}, {"1.0.0", "1.0.0-beta.2", true}, {"1.0.0-beta.1", "1.0.0", false}, {"0.2.0", "0.2.0", false}}
	for _, test := range tests {
		got, err := newerVersion(test.candidate, test.current)
		if err != nil {
			t.Fatalf("%s vs %s: %v", test.candidate, test.current, err)
		}
		if got != test.want {
			t.Fatalf("newerVersion(%q, %q) = %v", test.candidate, test.current, got)
		}
	}
}
