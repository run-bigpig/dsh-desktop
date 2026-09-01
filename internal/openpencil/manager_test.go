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

func TestStatusValidatesDiscoveryAndMCPIdentity(t *testing.T) {
	const token = "local-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" || r.Header.Get("X-OpenPencil-Token") != token {
			t.Fatalf("unexpected request path=%q token=%q", r.URL.Path, r.Header.Get("X-OpenPencil-Token"))
		}
		var request struct {
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Method != "ping" {
			t.Fatalf("ping request = %#v, %v", request, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":0,"result":{"_meta":{"server":"openpencil-mcp","mode":"live","token":"local-secret"}}}`))
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
	discoveryPath := filepath.Join(t.TempDir(), discoveryFilename)
	raw, _ := json.Marshal(discovery{
		Port: port, PID: 321, WriterPID: 321, Token: token,
		Timestamp: 1_700_000_000_000, Transport: "json-rpc",
	})
	if err := os.WriteFile(discoveryPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	binaryPath := filepath.Join(t.TempDir(), "openpencil-desktop.exe")
	if err := os.WriteFile(binaryPath, []byte("portable"), 0o700); err != nil {
		t.Fatal(err)
	}

	status, err := New(Options{BinaryPath: binaryPath, DiscoveryPath: discoveryPath}).Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !status.Bundled || !status.Running || status.Owned || status.Port != port || status.Token != token {
		t.Fatalf("status = %#v", status)
	}
}

func TestReadDiscoveryAcceptsOfficialTimestampAndRejectsUnknownFields(t *testing.T) {
	discoveryPath := filepath.Join(t.TempDir(), discoveryFilename)
	manager := New(Options{DiscoveryPath: discoveryPath})
	if err := os.WriteFile(discoveryPath, []byte(`{
		"port":3100,
		"pid":4242,
		"writerPid":4242,
		"token":"tok-1",
		"timestamp":1700000000000,
		"transport":"json-rpc"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	value, err := manager.readDiscovery()
	if err != nil {
		t.Fatal(err)
	}
	if value.Timestamp != 1_700_000_000_000 {
		t.Fatalf("timestamp = %d", value.Timestamp)
	}

	if err := os.WriteFile(discoveryPath, []byte(`{
		"port":3100,
		"pid":4242,
		"writerPid":4242,
		"token":"tok-1",
		"timestamp":1700000000000,
		"transport":"json-rpc",
		"unexpected":true
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.readDiscovery(); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown-field error = %v", err)
	}
}

func TestStatusTreatsStaleDiscoveryAsStopped(t *testing.T) {
	discoveryPath := filepath.Join(t.TempDir(), discoveryFilename)
	raw, _ := json.Marshal(discovery{Port: 1, PID: 321, WriterPID: 321, Token: "secret", Transport: "json-rpc"})
	if err := os.WriteFile(discoveryPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	status, err := New(Options{BinaryPath: filepath.Join(t.TempDir(), "missing.exe"), DiscoveryPath: discoveryPath}).Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Bundled || status.Running || status.Token != "" {
		t.Fatalf("status = %#v", status)
	}
}

func TestPingRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(make([]byte, maxRPCResponse+1))
	}))
	defer server.Close()

	manager := New(Options{})
	err := manager.ping(context.Background(), server.URL, "secret")
	if err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("ping error = %v", err)
	}
}

func TestShutdownCarriesDiscoveryTokenInRequestBody(t *testing.T) {
	const token = "shutdown-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Method string `json:"method"`
			Params struct {
				Token string `json:"token"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Method != "openpencil/shutdown" || request.Params.Token != token {
			t.Fatalf("shutdown request = %#v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true,"shuttingDown":true}}`))
	}))
	defer server.Close()

	if err := New(Options{}).shutdown(context.Background(), server.URL, token); err != nil {
		t.Fatal(err)
	}
}
