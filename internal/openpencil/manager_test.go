package openpencil

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestStatusReadsOfficialDiscoveryAndHealth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","version":"0.14.0","authRequired":true}`))
	}))
	defer server.Close()

	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	token := "local-secret"
	discoveryPath := filepath.Join(t.TempDir(), "mcp.json")
	writeDiscovery(t, discoveryPath, discovery{
		PID: 321, HTTPPort: port, AuthRequired: true, AuthToken: &token,
		Version: "0.14.0", StartedAt: "2026-09-02T00:00:00.000Z",
	})
	binaryPath, nodePath, mcpPath := writeBundleFiles(t)
	manager := New(Options{BinaryPath: binaryPath, NodePath: nodePath, MCPPath: mcpPath, DiscoveryPath: discoveryPath})

	status, err := manager.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !status.Bundled || !status.Running || status.Owned || status.Port != port || status.Token != token || status.Version != "0.14.0" {
		t.Fatalf("status = %#v", status)
	}
	if status.URL != server.URL+"/mcp" {
		t.Fatalf("url = %q", status.URL)
	}
}

func TestReadDiscoveryAcceptsFutureFields(t *testing.T) {
	discoveryPath := filepath.Join(t.TempDir(), "mcp.json")
	if err := os.WriteFile(discoveryPath, []byte(`{
		"pid":4242,
		"socketPath":null,
		"httpPort":3100,
		"authRequired":true,
		"authToken":"tok-1",
		"version":"0.14.0",
		"startedAt":"2026-09-02T00:00:00.000Z",
		"futureField":true
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	value, err := New(Options{DiscoveryPath: discoveryPath}).readDiscovery()
	if err != nil {
		t.Fatal(err)
	}
	if value.HTTPPort != 3100 || value.AuthToken == nil || *value.AuthToken != "tok-1" {
		t.Fatalf("discovery = %#v", value)
	}
}

func TestStatusTreatsDisconnectedCompanionAsStopped(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"no_app","version":"0.14.0","authRequired":false}`))
	}))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(parsed.Port())
	discoveryPath := filepath.Join(t.TempDir(), "mcp.json")
	writeDiscovery(t, discoveryPath, discovery{
		PID: 321, HTTPPort: port, AuthRequired: false, Version: "0.14.0",
		StartedAt: "2026-09-02T00:00:00.000Z",
	})
	status, err := New(Options{DiscoveryPath: discoveryPath}).Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Running || status.Port != port {
		t.Fatalf("status = %#v", status)
	}
}

func TestHealthRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(make([]byte, maxHTTPResponse+1))
	}))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(parsed.Port())
	err := func() error {
		_, err := New(Options{}).readHealth(context.Background(), port)
		return err
	}()
	if err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("health error = %v", err)
	}
}

func writeDiscovery(t *testing.T, path string, value discovery) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeBundleFiles(t *testing.T) (string, string, string) {
	t.Helper()
	directory := t.TempDir()
	paths := []string{
		filepath.Join(directory, "StarWeaveOpenPencilCompanion.exe"),
		filepath.Join(directory, "node.exe"),
		filepath.Join(directory, "openpencil-mcp-http.mjs"),
	}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("test"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return paths[0], paths[1], paths[2]
}
