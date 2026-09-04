package plugin

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

var (
	ErrBusy     = errors.New("another marketplace operation is running")
	ErrNotFound = errors.New("marketplace item not found")
	ErrInvalid  = errors.New("invalid marketplace request")
)

type Bridge struct {
	manager  *Manager
	server   *http.Server
	listener net.Listener
	token    string
	url      string
	mu       sync.RWMutex
	desktop  DesktopController
}

const DesktopBridgeAPIVersion = 1

type DesktopCapabilities struct {
	APIVersion   int      `json:"apiVersion"`
	Capabilities []string `json:"capabilities"`
}

type WindowState struct {
	Maximized  bool `json:"maximized"`
	Fullscreen bool `json:"fullscreen"`
}

type DesktopController interface {
	WindowState() (WindowState, error)
	MinimizeWindow() error
	ToggleMaximizeWindow() (WindowState, error)
	CloseWindow() error
	OpenBrowserURL(string) error
}

var (
	designSessionPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	designTokenPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

func StartBridge(manager *Manager) (*Bridge, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, fmt.Errorf("generate desktop plugin bridge token: %w", err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen for desktop plugin bridge: %w", err)
	}
	b := &Bridge{manager: manager, listener: listener, token: base64.RawURLEncoding.EncodeToString(raw)}
	b.url = "http://" + listener.Addr().String() + "/"
	b.server = &http.Server{Handler: b, ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() { _ = b.server.Serve(listener) }()
	return b, nil
}

func (b *Bridge) URL() string   { return b.url }
func (b *Bridge) Token() string { return b.token }
func (b *Bridge) Close() error  { return b.server.Close() }

func (b *Bridge) SetDesktopController(controller DesktopController) {
	b.mu.Lock()
	b.desktop = controller
	b.mu.Unlock()
}

func (b *Bridge) desktopController() DesktopController {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.desktop
}

func (b *Bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Header.Get("Origin") != "" {
		writeError(w, http.StatusForbidden, "browser origins are not allowed")
		return
	}
	wanted := "Bearer " + b.token
	provided := r.Header.Get("Authorization")
	if len(provided) != len(wanted) || subtle.ConstantTimeCompare([]byte(provided), []byte(wanted)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/desktop/capabilities":
		if b.desktopController() == nil {
			writeError(w, http.StatusServiceUnavailable, "desktop window controller is unavailable")
			return
		}
		capabilities := []string{"marketplace", "browser.open"}
		if runtime.GOOS == "windows" {
			capabilities = append(capabilities, "window.controls")
		}
		writeJSON(w, http.StatusOK, DesktopCapabilities{APIVersion: DesktopBridgeAPIVersion, Capabilities: capabilities})
	case r.Method == http.MethodGet && r.URL.Path == "/v1/window/state":
		controller := b.desktopController()
		if controller == nil {
			writeError(w, http.StatusServiceUnavailable, "desktop window controller is unavailable")
			return
		}
		state, err := controller.WindowState()
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, state)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/window/minimize":
		controller := b.desktopController()
		if controller == nil {
			writeError(w, http.StatusServiceUnavailable, "desktop window controller is unavailable")
			return
		}
		if err := controller.MinimizeWindow(); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case r.Method == http.MethodPost && r.URL.Path == "/v1/window/toggle-maximize":
		controller := b.desktopController()
		if controller == nil {
			writeError(w, http.StatusServiceUnavailable, "desktop window controller is unavailable")
			return
		}
		state, err := controller.ToggleMaximizeWindow()
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, state)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/window/close":
		controller := b.desktopController()
		if controller == nil {
			writeError(w, http.StatusServiceUnavailable, "desktop window controller is unavailable")
			return
		}
		if err := controller.CloseWindow(); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case r.Method == http.MethodPost && r.URL.Path == "/v1/browser/open":
		controller := b.desktopController()
		if controller == nil {
			writeError(w, http.StatusServiceUnavailable, "desktop window controller is unavailable")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var request struct {
			URL string `json:"url"`
		}
		if err := decoder.Decode(&request); err != nil || requireEOF(decoder) != nil || !validDesignBrowserURL(request.URL) {
			writeError(w, http.StatusBadRequest, "invalid StarWeave Design URL")
			return
		}
		if err := controller.OpenBrowserURL(request.URL); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case r.Method == http.MethodGet && r.URL.Path == "/v1/marketplace/catalog":
		if err := b.manager.RefreshCatalog(r.Context()); err != nil && b.manager.log != nil {
			_, _ = fmt.Fprintln(b.manager.log, "refresh Marketplace catalog:", err)
		}
		snapshot, err := b.manager.Catalog()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/marketplace/operations":
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var request MutationRequest
		if err := decoder.Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if err := requireEOF(decoder); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		operation, err := b.manager.Begin(request)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, ErrBusy) {
				status = http.StatusConflict
			}
			if errors.Is(err, ErrNotFound) {
				status = http.StatusNotFound
			}
			writeError(w, status, err.Error())
			return
		}
		writeJSON(w, http.StatusAccepted, operation)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/marketplace/operations/active":
		operation, ok := b.manager.ActiveOperation()
		if !ok {
			writeJSON(w, http.StatusOK, nil)
			return
		}
		writeJSON(w, http.StatusOK, operation)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/marketplace/operations/"):
		id := strings.TrimPrefix(r.URL.Path, "/v1/marketplace/operations/")
		operation, ok := b.manager.Operation(id)
		if !ok {
			writeError(w, http.StatusNotFound, "operation not found")
			return
		}
		writeJSON(w, http.StatusOK, operation)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func validDesignBrowserURL(raw string) bool {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "http" || target.Hostname() != "127.0.0.1" || target.Port() == "" || target.User != nil || target.Path != "/" || target.Fragment != "" {
		return false
	}
	query := target.Query()
	if len(query) < 2 || len(query) > 3 || len(query["session"]) != 1 || len(query["token"]) != 1 {
		return false
	}
	if !designSessionPattern.MatchString(query.Get("session")) || !designTokenPattern.MatchString(query.Get("token")) {
		return false
	}
	for key := range query {
		if key != "session" && key != "token" && key != "lan" {
			return false
		}
	}
	if lan := query.Get("lan"); lan != "" {
		origin, err := url.Parse(lan)
		if err != nil || origin.Scheme != "http" || origin.Port() != target.Port() || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || !isPrivateIPv4(origin.Hostname()) {
			return false
		}
	}
	return true
}

func isPrivateIPv4(value string) bool {
	ip := net.ParseIP(value)
	return ip != nil && ip.To4() != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast())
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return ErrInvalid
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
