package openpencil

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	harnessruntime "github.com/run-bigpig/dsh-desktop/internal/runtime"
)

const (
	discoveryFilename = ".op-mcp-port"
	serverName        = "openpencil-mcp"
	maxRPCResponse    = 1 << 20
)

type Status struct {
	Bundled bool   `json:"bundled"`
	Running bool   `json:"running"`
	Owned   bool   `json:"owned"`
	Port    int    `json:"port,omitempty"`
	URL     string `json:"url,omitempty"`
	Token   string `json:"token,omitempty"`
}

type Options struct {
	BinaryPath      string
	DiscoveryPath   string
	LaunchArgs      []string
	StartupTimeout  time.Duration
	ShutdownTimeout time.Duration
	Log             io.Writer
	HTTPClient      *http.Client
}

type Manager struct {
	mu              sync.Mutex
	binaryPath      string
	discoveryPath   string
	launchArgs      []string
	startupTimeout  time.Duration
	shutdownTimeout time.Duration
	log             io.Writer
	client          *http.Client
	process         *harnessruntime.ManagedProcess
	ownedPID        int
}

type discovery struct {
	Port      int    `json:"port"`
	PID       int    `json:"pid"`
	WriterPID int    `json:"writerPid"`
	Token     string `json:"token"`
	Transport string `json:"transport"`
}

func New(options Options) *Manager {
	startupTimeout := options.StartupTimeout
	if startupTimeout <= 0 {
		startupTimeout = 20 * time.Second
	}
	shutdownTimeout := options.ShutdownTimeout
	if shutdownTimeout <= 0 {
		shutdownTimeout = 5 * time.Second
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	return &Manager{
		binaryPath: options.BinaryPath, discoveryPath: options.DiscoveryPath,
		launchArgs: append([]string(nil), options.LaunchArgs...), startupTimeout: startupTimeout,
		shutdownTimeout: shutdownTimeout, log: options.Log, client: client,
	}
}

func DefaultDiscoveryPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".openpencil", discoveryFilename), nil
}

func (m *Manager) Status(ctx context.Context) (Status, error) {
	m.mu.Lock()
	ownedPID := m.ownedPID
	m.mu.Unlock()
	bundled := false
	if info, err := os.Stat(m.binaryPath); err == nil && !info.IsDir() {
		bundled = true
	}
	d, err := m.readDiscovery()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Status{Bundled: bundled}, nil
		}
		return Status{Bundled: bundled}, err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/mcp", d.Port)
	if err := m.ping(ctx, url, d.Token); err != nil {
		return Status{Bundled: bundled}, nil
	}
	return Status{
		Bundled: bundled, Running: true, Owned: ownedPID > 0 && (d.PID == ownedPID || d.WriterPID == ownedPID),
		Port: d.Port, URL: url, Token: d.Token,
	}, nil
}

func (m *Manager) Launch(ctx context.Context) (Status, error) {
	status, err := m.Status(ctx)
	if err != nil {
		return status, err
	}
	if status.Running {
		return status, nil
	}
	if !status.Bundled {
		return status, fmt.Errorf("bundled OpenPencil executable is unavailable")
	}
	m.mu.Lock()
	if m.process != nil {
		m.mu.Unlock()
		return Status{}, fmt.Errorf("OpenPencil launch is already in progress")
	}
	process := &harnessruntime.ManagedProcess{}
	m.process = process
	pid, startErr := process.Start(m.binaryPath, m.launchArgs, filepath.Dir(m.binaryPath), m.log)
	if startErr != nil {
		m.process = nil
		m.mu.Unlock()
		return Status{}, fmt.Errorf("start bundled OpenPencil: %w", startErr)
	}
	m.ownedPID = pid
	done := process.Done()
	m.mu.Unlock()

	deadline := time.NewTimer(m.startupTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = m.stopOwned(context.Background())
			return Status{}, ctx.Err()
		case <-deadline.C:
			_ = m.stopOwned(context.Background())
			return Status{}, fmt.Errorf("OpenPencil startup timed out after %s", m.startupTimeout)
		case <-done:
			_ = m.clearOwned(process)
			return Status{}, fmt.Errorf("OpenPencil exited before its MCP endpoint became ready")
		case <-ticker.C:
			status, err = m.Status(ctx)
			if err == nil && status.Running && status.Owned {
				go func() {
					<-done
					_ = m.clearOwned(process)
				}()
				return status, nil
			}
		}
	}
}

func (m *Manager) Close(ctx context.Context) error { return m.stopOwned(ctx) }

func (m *Manager) stopOwned(ctx context.Context) error {
	m.mu.Lock()
	process := m.process
	m.mu.Unlock()
	if process == nil {
		return nil
	}
	if status, err := m.Status(ctx); err == nil && status.Owned {
		_ = m.shutdown(ctx, status.URL, status.Token)
	}
	done := process.Done()
	if done == nil {
		return m.clearOwned(process)
	}
	timer := time.NewTimer(m.shutdownTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		_ = process.Kill()
	case <-timer.C:
		_ = process.Kill()
	case <-done:
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		_ = process.Kill()
	}
	return m.clearOwned(process)
}

func (m *Manager) clearOwned(process *harnessruntime.ManagedProcess) error {
	m.mu.Lock()
	if m.process == process {
		m.process = nil
		m.ownedPID = 0
	}
	m.mu.Unlock()
	return process.Close()
}

func (m *Manager) readDiscovery() (discovery, error) {
	raw, err := os.ReadFile(m.discoveryPath)
	if err != nil {
		return discovery{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var value discovery
	if err := decoder.Decode(&value); err != nil {
		return discovery{}, fmt.Errorf("read OpenPencil discovery: %w", err)
	}
	if value.Port < 1 || value.Port > 65535 || value.PID < 1 || value.WriterPID < 1 || strings.TrimSpace(value.Token) == "" || value.Transport != "json-rpc" {
		return discovery{}, fmt.Errorf("OpenPencil discovery is invalid")
	}
	return value, nil
}

func (m *Manager) ping(ctx context.Context, url, token string) error {
	var response struct {
		Result struct {
			Meta struct {
				Server string `json:"server"`
				Mode   string `json:"mode"`
				Token  string `json:"token"`
			} `json:"_meta"`
		} `json:"result"`
	}
	if err := m.rpc(ctx, url, token, map[string]any{"jsonrpc": "2.0", "id": 0, "method": "ping", "params": nil}, &response); err != nil {
		return err
	}
	if response.Result.Meta.Server != serverName || response.Result.Meta.Mode != "live" || response.Result.Meta.Token != token {
		return fmt.Errorf("OpenPencil MCP identity mismatch")
	}
	return nil
}

func (m *Manager) shutdown(ctx context.Context, url, token string) error {
	return m.rpc(ctx, url, token, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "openpencil/shutdown",
		"params":  map[string]string{"token": token},
	}, nil)
}

func (m *Manager) rpc(ctx context.Context, url, token string, payload any, target any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("X-OpenPencil-Token", token)
	response, err := m.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("OpenPencil MCP returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxRPCResponse {
		return fmt.Errorf("OpenPencil MCP response exceeded %d bytes", maxRPCResponse)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxRPCResponse+1))
	if err != nil {
		return fmt.Errorf("read OpenPencil MCP response: %w", err)
	}
	if len(raw) > maxRPCResponse {
		return fmt.Errorf("OpenPencil MCP response exceeded %d bytes", maxRPCResponse)
	}
	if target == nil {
		return nil
	}
	if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		scanner := bufio.NewScanner(bytes.NewReader(raw))
		scanner.Buffer(make([]byte, 64*1024), maxRPCResponse)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data:") {
				return json.Unmarshal(bytes.TrimSpace([]byte(strings.TrimPrefix(line, "data:"))), target)
			}
		}
		return scanner.Err()
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("decode OpenPencil MCP response: %w", err)
	}
	return nil
}
