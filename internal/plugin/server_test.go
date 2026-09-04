package plugin

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeDesktopController struct {
	state          WindowState
	minimized      int
	maximized      int
	closed         int
	openedURL      string
	openedNavigate bool
	openPath       string
	savePath       string
	saveName       string
}

func (f *fakeDesktopController) WindowState() (WindowState, error) { return f.state, nil }
func (f *fakeDesktopController) MinimizeWindow() error             { f.minimized++; return nil }
func (f *fakeDesktopController) ToggleMaximizeWindow() (WindowState, error) {
	f.maximized++
	f.state.Maximized = !f.state.Maximized
	return f.state, nil
}
func (f *fakeDesktopController) CloseWindow() error { f.closed++; return nil }
func (f *fakeDesktopController) OpenDesignWindow(url string, navigate bool) error {
	f.openedURL = url
	f.openedNavigate = navigate
	return nil
}
func (f *fakeDesktopController) ChooseDesignOpenPath() (string, error) { return f.openPath, nil }
func (f *fakeDesktopController) ChooseDesignSavePath(name string) (string, error) {
	f.saveName = name
	return f.savePath, nil
}

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

func TestBridgeReturnsActiveMarketplaceOperation(t *testing.T) {
	record := &operationRecord{Operation: Operation{
		ID: "operation-id", PluginID: "plugin-id", Action: Install,
		Phase: Downloading, Progress: 20, Message: "downloading",
	}}
	manager := &Manager{
		operations:      map[string]*operationRecord{"operation-id": record},
		activeOperation: "operation-id",
	}
	bridge := &Bridge{manager: manager, token: "secret"}

	request := httptest.NewRequest(http.MethodGet, "/v1/marketplace/operations/active", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":"operation-id"`) {
		t.Fatalf("active operation response = %d %s", response.Code, response.Body.String())
	}

	record.Phase = Completed
	request = httptest.NewRequest(http.MethodGet, "/v1/marketplace/operations/active", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response = httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != "null" {
		t.Fatalf("terminal operation response = %d %s", response.Code, response.Body.String())
	}
}

func TestBridgeExposesOnlyAuthenticatedDesktopWindowActions(t *testing.T) {
	controller := &fakeDesktopController{}
	bridge := &Bridge{manager: &Manager{operations: map[string]*operationRecord{}}, token: "secret", desktop: controller}

	request := httptest.NewRequest(http.MethodGet, "/v1/desktop/capabilities", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"apiVersion":1`) || !strings.Contains(response.Body.String(), `"design.open"`) || !strings.Contains(response.Body.String(), `"design.open-file"`) || !strings.Contains(response.Body.String(), `"design.save"`) {
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

func TestBridgeChoosesDesignOpenPathThroughDesktop(t *testing.T) {
	controller := &fakeDesktopController{openPath: `C:\Users\test\Desktop\Canvas.fig`}
	bridge := &Bridge{manager: &Manager{operations: map[string]*operationRecord{}}, token: "secret", desktop: controller}
	request := httptest.NewRequest(http.MethodPost, "/v1/design/open-path", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	bridge.ServeHTTP(response, request)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"cancelled":false`) {
		t.Fatalf("open path response = %d %s", response.Code, response.Body.String())
	}
}

func TestBridgeOpensOnlyAuthenticatedLoopbackDesignURLs(t *testing.T) {
	controller := &fakeDesktopController{}
	bridge := &Bridge{manager: &Manager{operations: map[string]*operationRecord{}}, token: "secret", desktop: controller}
	validURL := "http://127.0.0.1:43123/?session=123e4567-e89b-42d3-a456-426614174000&token=abcdefghijklmnopqrstuvwxyzABCDEFGH_12345678&lan=http%3A%2F%2F192.168.1.5%3A43123"

	request := httptest.NewRequest(http.MethodPost, "/v1/design/open", strings.NewReader(`{"url":"`+validURL+`","navigate":false}`))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	bridge.ServeHTTP(response, request)
	if response.Code != http.StatusOK || controller.openedURL != validURL || controller.openedNavigate {
		t.Fatalf("open response = %d %s; url = %q", response.Code, response.Body.String(), controller.openedURL)
	}

	for _, invalidURL := range []string{
		"https://example.com/",
		"http://127.0.0.1:43123/?session=123e4567-e89b-42d3-a456-426614174000&token=short",
		"http://192.168.1.5:43123/?session=123e4567-e89b-42d3-a456-426614174000&token=abcdefghijklmnopqrstuvwxyzABCDEFGH_12345678",
	} {
		request = httptest.NewRequest(http.MethodPost, "/v1/design/open", strings.NewReader(`{"url":"`+invalidURL+`"}`))
		request.Header.Set("Authorization", "Bearer secret")
		response = httptest.NewRecorder()
		bridge.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid URL %q returned %d", invalidURL, response.Code)
		}
	}
}

func TestBridgeChoosesDesignSavePathThroughDesktop(t *testing.T) {
	controller := &fakeDesktopController{savePath: `C:\\Users\\test\\Desktop\\Canvas.fig`}
	bridge := &Bridge{manager: &Manager{operations: map[string]*operationRecord{}}, token: "secret", desktop: controller}
	request := httptest.NewRequest(http.MethodPost, "/v1/design/save-path", strings.NewReader(`{"suggestedName":"Landing.fig"}`))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	bridge.ServeHTTP(response, request)

	if response.Code != http.StatusOK || controller.saveName != "Landing.fig" || !strings.Contains(response.Body.String(), `"cancelled":false`) {
		t.Fatalf("save path response = %d %s; name = %q", response.Code, response.Body.String(), controller.saveName)
	}
}
