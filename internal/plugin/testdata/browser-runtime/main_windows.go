// Integration fixture using the product browser manager and authenticated bridge.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"time"
	"unsafe"

	"github.com/run-bigpig/dsh-desktop/internal/browser"
	"github.com/run-bigpig/dsh-desktop/internal/plugin"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

func main() {
	if len(os.Args) != 3 {
		panic("usage: browser-runtime.exe loader manifest")
	}
	root, err := os.MkdirTemp("", "starweave-browser-runtime-")
	if err != nil {
		panic(err)
	}
	bridge, err := plugin.StartBridge(nil)
	if err != nil {
		panic(err)
	}
	defer bridge.Close()
	var window *application.WebviewWindow
	manager := browser.New(filepath.Join(root, "browser"), os.Args[1], func() unsafe.Pointer { return window.NativeWindow() })
	bridge.SetBrowserController(manager)
	var app *application.App
	mux := http.NewServeMux()
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Browser runtime</title><style>body{background:#16afcc;font:20px system-ui}</style><h1>Session browser</h1><input id="input"><a href="https://example.com" target="_blank">link</a>`)
	})
	mux.HandleFunc("/shell", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<!doctype html><title>StarWeave Browser Integration</title><h1>Product native browser adapter</h1><p>Viewport: right side</p>`)
	})
	mux.HandleFunc("/reset", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+bridge.Token() {
			http.Error(w, "unauthorized", 401)
			return
		}
		manager.Reset()
		fmt.Fprint(w, `true`)
	})
	mux.HandleFunc("/quit", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+bridge.Token() {
			http.Error(w, "unauthorized", 401)
			return
		}
		manager.Reset()
		fmt.Fprint(w, `true`)
		go func() { time.Sleep(100 * time.Millisecond); app.Quit() }()
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	app = application.New(application.Options{Name: "StarWeave Browser Integration", Windows: application.WindowsOptions{WebviewUserDataPath: filepath.Join(root, "shell")}})
	window = app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "StarWeave Browser Integration", Width: 1200, Height: 800, URL: server.URL + "/shell"})
	window.RegisterHook(events.Windows.WebViewNavigationCompleted, func(*application.WindowEvent) {
		data, _ := json.Marshal(map[string]any{"url": bridge.URL(), "token": bridge.Token(), "page": server.URL + "/page", "control": server.URL, "root": root, "pid": os.Getpid()})
		if err := os.WriteFile(os.Args[2], data, 0600); err != nil {
			panic(err)
		}
	})
	if err := app.Run(); err != nil {
		panic(err)
	}
}
