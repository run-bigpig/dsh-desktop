package openpencil

import (
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

const maxHTTPResponse = 1 << 20

type Status struct {
	Bundled bool   `json:"bundled"`
	Running bool   `json:"running"`
	Owned   bool   `json:"owned"`
	Port    int    `json:"port,omitempty"`
	URL     string `json:"url,omitempty"`
	Token   string `json:"token,omitempty"`
	Version string `json:"version,omitempty"`
}

type Options struct {
	BinaryPath       string
	NodePath         string
	MCPPath          string
	DiscoveryPath    string
	WorkingDirectory string
	StartupTimeout   time.Duration
	ShutdownTimeout  time.Duration
	Log              io.Writer
	HTTPClient       *http.Client
}

type Manager struct {
	mu               sync.Mutex
	binaryPath       string
	nodePath         string
	mcpPath          string
	discoveryPath    string
	workingDirectory string
	startupTimeout   time.Duration
	shutdownTimeout  time.Duration
	log              io.Writer
	client           *http.Client
	mcpProcess       *harnessruntime.ManagedProcess
	appProcess       *harnessruntime.ManagedProcess
	mcpPID           int
	launching        bool
}

type discovery struct {
	PID          int     `json:"pid"`
	SocketPath   *string `json:"socketPath"`
	HTTPPort     int     `json:"httpPort"`
	AuthRequired bool    `json:"authRequired"`
	AuthToken    *string `json:"authToken"`
	Version      string  `json:"version"`
	StartedAt    string  `json:"startedAt"`
}

type health struct {
	Status       string `json:"status"`
	Version      string `json:"version"`
	AuthRequired bool   `json:"authRequired"`
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
		binaryPath: options.BinaryPath, nodePath: options.NodePath, mcpPath: options.MCPPath,
		discoveryPath: options.DiscoveryPath, workingDirectory: options.WorkingDirectory,
		startupTimeout: startupTimeout, shutdownTimeout: shutdownTimeout, log: options.Log, client: client,
	}
}

func (m *Manager) Status(ctx context.Context) (Status, error) {
	bundled := m.bundleAvailable()
	d, err := m.readDiscovery()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Status{Bundled: bundled}, nil
		}
		return Status{Bundled: bundled}, err
	}
	h, err := m.readHealth(ctx, d.HTTPPort)
	if err != nil {
		return Status{Bundled: bundled}, nil
	}
	if h.Version != d.Version || h.AuthRequired != d.AuthRequired {
		return Status{Bundled: bundled}, fmt.Errorf("OpenPencil discovery and health identity mismatch")
	}
	m.mu.Lock()
	owned := m.mcpPID > 0 && d.PID == m.mcpPID
	m.mu.Unlock()
	token := ""
	if d.AuthToken != nil {
		token = *d.AuthToken
	}
	return Status{
		Bundled: bundled, Running: h.Status == "ok", Owned: owned, Port: d.HTTPPort,
		URL: fmt.Sprintf("http://127.0.0.1:%d/mcp", d.HTTPPort), Token: token, Version: d.Version,
	}, nil
}

func (m *Manager) Launch(ctx context.Context) (Status, error) {
	status, err := m.Status(ctx)
	if err == nil && status.Running {
		return status, nil
	}
	if !m.bundleAvailable() {
		return Status{Bundled: false}, fmt.Errorf("bundled OpenPencil Companion is unavailable")
	}
	_ = m.Stop(context.Background())

	m.mu.Lock()
	if m.launching {
		m.mu.Unlock()
		return Status{}, fmt.Errorf("OpenPencil launch is already in progress")
	}
	m.launching = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.launching = false
		m.mu.Unlock()
	}()

	if err := os.MkdirAll(filepath.Dir(m.discoveryPath), 0o700); err != nil {
		return Status{}, fmt.Errorf("prepare OpenPencil discovery directory: %w", err)
	}
	_ = os.Remove(m.discoveryPath)
	mcpProcess := &harnessruntime.ManagedProcess{}
	mcpEnvironment := []string{
		"PORT=0",
		"OPENPENCIL_MCP_TCP=1",
		"OPENPENCIL_MCP_DISCOVERY_PATH=" + m.discoveryPath,
		"OPENPENCIL_MCP_ROOT=" + m.workingDirectory,
		"OPENPENCIL_MCP_CORS_ORIGIN=http://tauri.localhost",
	}
	mcpPID, err := mcpProcess.StartWithEnv(m.nodePath, []string{m.mcpPath}, filepath.Dir(m.mcpPath), mcpEnvironment, m.log)
	if err != nil {
		return Status{}, fmt.Errorf("start bundled OpenPencil MCP server: %w", err)
	}
	m.mu.Lock()
	m.mcpProcess, m.mcpPID = mcpProcess, mcpPID
	m.mu.Unlock()
	if _, err := m.waitForHealth(ctx, mcpPID, false, mcpProcess.Done(), nil); err != nil {
		_ = m.Stop(context.Background())
		return Status{}, err
	}

	appProcess := &harnessruntime.ManagedProcess{}
	appEnvironment := []string{
		"STARWEAVE_OPENPENCIL_MCP_DISCOVERY_PATH=" + m.discoveryPath,
		"OPENPENCIL_MCP_DISCOVERY_PATH=" + m.discoveryPath,
	}
	if _, err := appProcess.StartWithEnv(m.binaryPath, []string{"--hidden"}, filepath.Dir(m.binaryPath), appEnvironment, m.log); err != nil {
		_ = m.Stop(context.Background())
		return Status{}, fmt.Errorf("start bundled OpenPencil Companion: %w", err)
	}
	m.mu.Lock()
	m.appProcess = appProcess
	m.mu.Unlock()
	if _, err := m.waitForHealth(ctx, mcpPID, true, mcpProcess.Done(), appProcess.Done()); err != nil {
		_ = m.Stop(context.Background())
		return Status{}, err
	}
	return m.Status(ctx)
}

func (m *Manager) Show(ctx context.Context) (Status, error) {
	return m.signalWindow(ctx, "--show")
}

func (m *Manager) Hide(ctx context.Context) (Status, error) {
	return m.signalWindow(ctx, "--hide")
}

func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	appProcess, mcpProcess := m.appProcess, m.mcpProcess
	m.appProcess, m.mcpProcess, m.mcpPID = nil, nil, 0
	m.mu.Unlock()
	if appProcess != nil {
		_ = m.sendWindowCommand(ctx, "--quit")
	}
	appErr := m.stopProcess(ctx, appProcess)
	mcpErr := m.stopProcess(ctx, mcpProcess)
	_ = os.Remove(m.discoveryPath)
	if appErr != nil {
		return appErr
	}
	return mcpErr
}

func (m *Manager) Close(ctx context.Context) error { return m.Stop(ctx) }

func (m *Manager) signalWindow(ctx context.Context, command string) (Status, error) {
	status, err := m.Status(ctx)
	if err != nil {
		return status, err
	}
	if !status.Running {
		return status, fmt.Errorf("OpenPencil Companion is not running")
	}
	if err := m.sendWindowCommand(ctx, command); err != nil {
		return status, fmt.Errorf("send OpenPencil window command: %w", err)
	}
	return status, nil
}

func (m *Manager) sendWindowCommand(ctx context.Context, command string) error {
	process := &harnessruntime.ManagedProcess{}
	if _, err := process.StartWithEnv(m.binaryPath, []string{command}, filepath.Dir(m.binaryPath), nil, m.log); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		_ = process.Kill()
		_ = process.Close()
		return ctx.Err()
	case <-time.After(5 * time.Second):
		_ = process.Kill()
		_ = process.Close()
		return fmt.Errorf("OpenPencil window command timed out")
	case <-process.Done():
		return process.Close()
	}
}

func (m *Manager) waitForHealth(ctx context.Context, expectedPID int, requireApp bool, mcpDone, appDone <-chan struct{}) (health, error) {
	deadline := time.NewTimer(m.startupTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return health{}, ctx.Err()
		case <-deadline.C:
			return health{}, fmt.Errorf("OpenPencil startup timed out after %s", m.startupTimeout)
		case <-mcpDone:
			return health{}, fmt.Errorf("OpenPencil MCP server exited during startup")
		case <-appDone:
			return health{}, fmt.Errorf("OpenPencil Companion exited during startup")
		case <-ticker.C:
			d, err := m.readDiscovery()
			if err != nil || d.PID != expectedPID {
				continue
			}
			h, err := m.readHealth(ctx, d.HTTPPort)
			if err == nil && h.Version == d.Version && h.AuthRequired == d.AuthRequired && (!requireApp || h.Status == "ok") {
				return h, nil
			}
		}
	}
}

func (m *Manager) readDiscovery() (discovery, error) {
	raw, err := os.ReadFile(m.discoveryPath)
	if err != nil {
		return discovery{}, err
	}
	if len(raw) > maxHTTPResponse {
		return discovery{}, fmt.Errorf("OpenPencil discovery exceeds %d bytes", maxHTTPResponse)
	}
	var value discovery
	if err := json.Unmarshal(raw, &value); err != nil {
		return discovery{}, fmt.Errorf("read OpenPencil discovery: %w", err)
	}
	if value.PID < 1 || value.HTTPPort < 1 || value.HTTPPort > 65535 || strings.TrimSpace(value.Version) == "" || strings.TrimSpace(value.StartedAt) == "" {
		return discovery{}, fmt.Errorf("OpenPencil discovery is invalid")
	}
	if value.AuthRequired && (value.AuthToken == nil || strings.TrimSpace(*value.AuthToken) == "") {
		return discovery{}, fmt.Errorf("OpenPencil discovery is missing its authentication token")
	}
	return value, nil
}

func (m *Manager) readHealth(ctx context.Context, port int) (health, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/health", port), nil)
	if err != nil {
		return health{}, err
	}
	response, err := m.client.Do(request)
	if err != nil {
		return health{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return health{}, fmt.Errorf("OpenPencil MCP health returned HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxHTTPResponse+1))
	if err != nil {
		return health{}, err
	}
	if len(raw) > maxHTTPResponse {
		return health{}, fmt.Errorf("OpenPencil MCP health exceeded %d bytes", maxHTTPResponse)
	}
	var value health
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&value); err != nil {
		return health{}, err
	}
	if value.Status != "ok" && value.Status != "no_app" {
		return health{}, fmt.Errorf("OpenPencil MCP health is invalid")
	}
	return value, nil
}

func (m *Manager) bundleAvailable() bool {
	for _, path := range []string{m.binaryPath, m.nodePath, m.mcpPath} {
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			return false
		}
	}
	return true
}

func (m *Manager) stopProcess(ctx context.Context, process *harnessruntime.ManagedProcess) error {
	if process == nil {
		return nil
	}
	done := process.Done()
	_ = process.Kill()
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
		case <-time.After(m.shutdownTimeout):
		}
	}
	return process.Close()
}
