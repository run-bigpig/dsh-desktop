// A disposable native WebView for scripts/browser-smoke.cjs [Wails-CDP-URL].
// It uses the production font gateway/injection with no Harness user profile.
package main

import (
	"log"
	"net/http"
	"net/http/httptest"
	"os"

	"github.com/run-bigpig/dsh-desktop/internal/plugin"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

func main() {
	data, err := os.MkdirTemp("", "starweave-font-webview-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(data)
	bridge, err := plugin.StartBridge(nil)
	if err != nil {
		log.Fatal(err)
	}
	defer bridge.Close()
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><title>StarWeave 中文字体测试</title><body>等待画布测试</body>"))
	}))
	defer page.Close()
	script, err := bridge.DesignFontScript(page.URL)
	if err != nil {
		log.Fatal(err)
	}
	app := application.New(application.Options{
		Name: "StarWeave Font Smoke",
		Assets: application.AssetOptions{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<!doctype html><script type="module" src="/wails/runtime.js"></script><body>启动字体测试</body>`))
		})},
		Windows: application.WindowsOptions{WebviewUserDataPath: data, AdditionalBrowserArgs: []string{"--remote-debugging-port=9229", "--remote-debugging-address=127.0.0.1"}},
	})
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "StarWeave 中文字体验收", Width: 1440, Height: 1000, URL: "/"})
	// Match the desktop lifecycle: first load the local Wails startup page,
	// then navigate directly to the external loopback page.
	window.RegisterHook(events.Common.WindowRuntimeReady, func(*application.WindowEvent) { window.SetURL(page.URL) })
	window.RegisterHook(events.Windows.WebViewNavigationCompleted, func(*application.WindowEvent) { window.ExecJS(script) })
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
