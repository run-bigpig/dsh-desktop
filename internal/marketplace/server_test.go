package marketplace

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeDesktopController struct {
	state     WindowState
	minimized int
	maximized int
	closed    int
}

func (f *fakeDesktopController) WindowState() (WindowState, error) { return f.state, nil }
func (f *fakeDesktopController) MinimizeWindow() error             { f.minimized++; return nil }
func (f *fakeDesktopController) ToggleMaximizeWindow() (WindowState, error) {
	f.maximized++
	f.state.Maximized = !f.state.Maximized
	return f.state, nil
}
func (f *fakeDesktopController) CloseWindow() error { f.closed++; return nil }

func TestBridgeRequiresTokenAndRejectsBrowserOrigin(t *testing.T) {
	manager := &Manager{operations: map[string]*operationRecord{}}
	bridge := &Bridge{manager: manager, token: "secret"}

	request := httptest.NewRequest(http.MethodGet, "/v1/marketplace/operations/missing", nil)
	response := httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/marketplace/operations/missing", nil)
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("Origin", "http://127.0.0.1")
	response = httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestBridgeRejectsOversizedOrUnknownMutationFields(t *testing.T) {
	manager := &Manager{operations: map[string]*operationRecord{}}
	bridge := &Bridge{manager: manager, token: "secret"}
	request := httptest.NewRequest(http.MethodPost, "/v1/marketplace/operations", strings.NewReader(`{"pluginId":"x","action":"install","extra":true}`))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestBridgeExposesOnlyAuthenticatedDesktopWindowActions(t *testing.T) {
	controller := &fakeDesktopController{}
	bridge := &Bridge{manager: &Manager{operations: map[string]*operationRecord{}}, token: "secret", desktop: controller}

	request := httptest.NewRequest(http.MethodGet, "/v1/desktop/capabilities", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"apiVersion":1`) {
		t.Fatalf("capabilities response = %d %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/window/state", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response = httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"maximized":false`) {
		t.Fatalf("state response = %d %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/v1/window/minimize", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response = httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusOK || controller.minimized != 1 {
		t.Fatalf("minimize response = %d %s; calls = %d", response.Code, response.Body.String(), controller.minimized)
	}

	request = httptest.NewRequest(http.MethodPost, "/v1/window/toggle-maximize", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response = httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusOK || controller.maximized != 1 || !strings.Contains(response.Body.String(), `"maximized":true`) {
		t.Fatalf("toggle response = %d %s; calls = %d", response.Code, response.Body.String(), controller.maximized)
	}

	request = httptest.NewRequest(http.MethodPost, "/v1/window/close", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response = httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusOK || controller.closed != 1 {
		t.Fatalf("close response = %d %s; calls = %d", response.Code, response.Body.String(), controller.closed)
	}
}
