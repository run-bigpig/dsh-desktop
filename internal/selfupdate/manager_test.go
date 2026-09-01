package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

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
	if store.Snapshot().DesktopUpdate.Phase != state.DesktopUpdateInstalling {
		t.Fatalf("unexpected phase %q", store.Snapshot().DesktopUpdate.Phase)
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

func TestChecksumSidecarMustNameInstallerAsset(t *testing.T) {
	digest := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := parseChecksumFile([]byte(digest+"  unrelated.exe\n"), buildinfo.WindowsX64Asset); err == nil {
		t.Fatal("checksum for an unrelated asset was accepted")
	}
	got, err := parseChecksumFile([]byte(digest+" *"+buildinfo.WindowsX64Asset+"\n"), buildinfo.WindowsX64Asset)
	if err != nil {
		t.Fatal(err)
	}
	if got != digest {
		t.Fatalf("checksum = %q", got)
	}
}

func TestFailedCheckClearsStaleUpdate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store := state.NewStore(paths.State)
	store.SetAvailableUpdate(&state.DesktopUpdate{Version: "9.9.9"})
	manager := New(paths, store, "0.2.0", server.URL, server.Client())
	if _, err := manager.Check(context.Background()); err == nil {
		t.Fatal("failed release check returned no error")
	}
	if store.Snapshot().AvailableUpdate != nil {
		t.Fatal("failed release check left a stale update available")
	}
}

func TestDownloadRejectsSizeMismatch(t *testing.T) {
	payload := []byte("larger than declared")
	digest := sha256.Sum256(payload)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(payload)
	}))
	defer server.Close()
	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store := state.NewStore(paths.State)
	store.SetAvailableUpdate(&state.DesktopUpdate{
		Version:     "0.3.0",
		AssetName:   buildinfo.WindowsX64Asset,
		DownloadURL: server.URL,
		SHA256:      hex.EncodeToString(digest[:]),
		Size:        int64(len(payload) - 1),
	})
	manager := New(paths, store, "0.2.0", server.URL, server.Client())
	if _, err := manager.Download(context.Background()); err == nil {
		t.Fatal("download with a mismatched size was accepted")
	}
	if store.Snapshot().DesktopUpdate.Phase != state.DesktopUpdateFailed {
		t.Fatalf("unexpected phase %q", store.Snapshot().DesktopUpdate.Phase)
	}
}

func TestDownloadReportsProgress(t *testing.T) {
	first := []byte("first download chunk")
	second := []byte("second download chunk")
	payload := append(append([]byte(nil), first...), second...)
	digest := sha256.Sum256(payload)
	firstWritten := make(chan struct{})
	continueDownload := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		_, _ = writer.Write(first)
		writer.(http.Flusher).Flush()
		close(firstWritten)
		<-continueDownload
		_, _ = writer.Write(second)
	}))
	defer server.Close()

	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store := state.NewStore(paths.State)
	store.SetAvailableUpdate(&state.DesktopUpdate{Version: "0.3.0", AssetName: buildinfo.WindowsX64Asset, DownloadURL: server.URL, SHA256: hex.EncodeToString(digest[:]), Size: int64(len(payload))})
	manager := New(paths, store, "0.2.0", server.URL, server.Client())
	result := make(chan error, 1)
	go func() {
		_, err := manager.Download(context.Background())
		result <- err
	}()
	<-firstWritten

	deadline := time.Now().Add(2 * time.Second)
	for {
		status := store.Snapshot().DesktopUpdate
		if status.Downloaded == int64(len(first)) {
			if status.Phase != state.DesktopUpdateDownloading || status.Progress <= 0 || status.Progress >= 100 || !status.CanCancel {
				t.Fatalf("unexpected progress status: %#v", status)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("download progress was not reported: %#v", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(continueDownload)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestDownloadCancellationRemovesPartialInstaller(t *testing.T) {
	payload := []byte("partial installer payload")
	digest := sha256.Sum256(payload)
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		_, _ = writer.Write(payload[:8])
		writer.(http.Flusher).Flush()
		close(started)
		<-request.Context().Done()
	}))
	defer server.Close()

	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store := state.NewStore(paths.State)
	update := &state.DesktopUpdate{Version: "0.3.0", AssetName: buildinfo.WindowsX64Asset, DownloadURL: server.URL, SHA256: hex.EncodeToString(digest[:]), Size: int64(len(payload))}
	store.SetAvailableUpdate(update)
	manager := New(paths, store, "0.2.0", server.URL, server.Client())
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := manager.Download(ctx)
		result <- err
	}()
	<-started
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("download error = %v", err)
	}
	status := store.Snapshot().DesktopUpdate
	if status.Phase != state.DesktopUpdateCancelled || !status.CanRetry || status.CanCancel {
		t.Fatalf("unexpected cancelled status: %#v", status)
	}
	partial := filepath.Join(paths.Updates, "v"+update.Version, update.AssetName+".part")
	if _, err := os.Stat(partial); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial installer still exists: %v", err)
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
