// A disposable Wails/WebView2 feasibility probe, never linked into StarWeave.
// COM interfaces and vtable offsets come from the official WebView2 SDK header.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"golang.org/x/sys/windows"
)

type com struct{ table *[128]uintptr }

func (c *com) call(index int, args ...uintptr) error {
	args = append([]uintptr{uintptr(unsafe.Pointer(c))}, args...)
	r, _, _ := syscall.SyscallN(c.table[index], args...)
	if int32(r) < 0 {
		return fmt.Errorf("COM method %d: HRESULT 0x%08x", index, uint32(r))
	}
	return nil
}

func ptr[T any](v *T) uintptr { return uintptr(unsafe.Pointer(v)) }
func wide(s string) *uint16   { return windows.StringToUTF16Ptr(s) }

type callback struct {
	table  *[4]uintptr
	refs   atomic.Int32
	invoke func(uintptr, uintptr)
	iid    windows.GUID
}

// Keep callbacks rooted for the short lifetime of this isolated probe. Production
// would release each callback when its COM reference count reaches zero.
var callbacks []*callback
var callbackTable = [4]uintptr{
	syscall.NewCallback(func(self, iid, out uintptr) uintptr {
		c := (*callback)(unsafe.Pointer(self))
		want := *(*windows.GUID)(unsafe.Pointer(iid))
		unknown, _ := windows.GUIDFromString("{00000000-0000-0000-C000-000000000046}")
		if want != c.iid && want != unknown {
			*(*uintptr)(unsafe.Pointer(out)) = 0
			return 0x80004002
		}
		*(*uintptr)(unsafe.Pointer(out)) = self
		(*callback)(unsafe.Pointer(self)).refs.Add(1)
		return 0
	}),
	syscall.NewCallback(func(self uintptr) uintptr { return uintptr((*callback)(unsafe.Pointer(self)).refs.Add(1)) }),
	syscall.NewCallback(func(self uintptr) uintptr { return uintptr((*callback)(unsafe.Pointer(self)).refs.Add(-1)) }),
	syscall.NewCallback(func(self, result, value uintptr) uintptr {
		(*callback)(unsafe.Pointer(self)).invoke(result, value)
		return 0
	}),
}

func completed(iid string, fn func(uintptr, uintptr)) *callback {
	id, err := windows.GUIDFromString(iid)
	if err != nil {
		panic(err)
	}
	c := &callback{table: &callbackTable, invoke: fn, iid: id}
	c.refs.Store(1)
	callbacks = append(callbacks, c)
	return c
}

type rect struct{ Left, Top, Right, Bottom int32 }
type tab struct {
	controller, view *com
	hwnd             uintptr
}

var user32 = windows.NewLazySystemDLL("user32.dll")

type command struct {
	Op      string          `json:"op"`
	Tab     string          `json:"tab"`
	Profile string          `json:"profile"`
	Script  string          `json:"script"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Visible bool            `json:"visible"`
	Bounds  rect            `json:"bounds"`
}
type result struct {
	Value any    `json:"value,omitempty"`
	Error string `json:"error,omitempty"`
}

const shellPage = `<!doctype html><meta charset="utf-8"><title>StarWeave Browser Gate</title>
<style>body{font:16px system-ui;background:#f4f4f4;margin:24px}#slot{position:absolute;left:620px;top:90px;width:500px;height:560px;background:#ddd}dialog{position:fixed;inset:0;width:90vw;height:80vh;background:rgb(255,0,180);z-index:2147483647}dialog::backdrop{background:#9008}</style>
<h1>Wails 原生侧栏验证</h1><input placeholder="主界面输入"><button onclick="document.querySelector('dialog').showModal()">打开主界面弹窗</button>
<script>setInterval(async()=>{const open=await(await fetch("/modal")).json();const d=document.querySelector("dialog");if(open&&!d.open)d.showModal();if(!open&&d.open)d.close()},50)</script><div id="slot">原生浏览器区域</div><dialog><h2>Harness 弹窗替身</h2><input placeholder="弹窗输入"><button onclick="this.closest('dialog').close()">关闭</button></dialog>`
const browserPage = `<!doctype html><meta charset="utf-8"><title>Isolated browser</title>
<style>body{background:rgb(0,180,220);font:20px system-ui;padding:20px}input{font:inherit;width:90%}</style>
<h1>会话浏览器</h1><input id="input" placeholder="输入中文 / keyboard input"><button onclick="document.querySelector('#count').textContent=++window.clicks">Click</button><output id="count">0</output>
<script>window.clicks=0;window.inputs=[];document.querySelector('input').addEventListener('input',e=>inputs.push(e.target.value));</script>`

func main() {
	if len(os.Args) != 3 {
		log.Fatal("usage: browser-workspace.exe SDK-directory manifest-path")
	}
	data, err := os.MkdirTemp("", "starweave-browser-gate-")
	if err != nil {
		log.Fatal(err)
	}
	// The runner removes this exact temporary profile after the process exits.

	loader, err := windows.LoadDLL(filepath.Join(os.Args[1], "WebView2Loader.dll"))
	if err != nil {
		log.Fatal(err)
	}
	defer loader.Release()
	create, err := loader.FindProc("CreateCoreWebView2EnvironmentWithOptions")
	if err != nil {
		log.Fatal(err)
	}
	secret := make([]byte, 24)
	if _, err := rand.Read(secret); err != nil {
		log.Fatal(err)
	}
	token := hex.EncodeToString(secret)
	var app *application.App
	var window *application.WebviewWindow
	var environment *com
	tabs := map[string]*tab{}
	ready := make(chan result, 1)
	var modal atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/modal", func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(modal.Load()) })
	server := httptest.NewServer(mux)
	defer server.Close()
	mux.HandleFunc("/shell", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, shellPage)
	})
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, browserPage)
	})
	mux.HandleFunc("/command", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Origin") != "" {
			http.Error(w, "Forbidden", 403)
			return
		}
		var cmd command
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&cmd); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		out := make(chan result, 1)
		done := func(value any, err error) {
			res := result{Value: value}
			if err != nil {
				res.Error = err.Error()
			}
			select {
			case out <- res:
			default:
			}
		}
		if cmd.Op == "ready" {
			select {
			case res := <-ready:
				ready <- res
				json.NewEncoder(w).Encode(res)
			case <-time.After(25 * time.Second):
				json.NewEncoder(w).Encode(result{Error: "environment timeout"})
			}
			return
		}
		application.InvokeSync(func() {
			t := tabs[cmd.Tab]
			switch cmd.Op {
			case "create":
				if environment == nil || t != nil || cmd.Profile == "" {
					done(nil, fmt.Errorf("invalid create"))
					return
				}
				var options *com
				if err := environment.call(20, ptr(&options)); err != nil {
					done(nil, err)
					return
				}
				defer options.call(2)
				if err := options.call(4, ptr(wide(cmd.Profile))); err != nil {
					done(nil, err)
					return
				}
				b := cmd.Bounds
				hwnd, _, winErr := user32.NewProc("CreateWindowExW").Call(0, ptr(wide("STATIC")), 0, 0x40000000|0x04000000|0x02000000, uintptr(b.Left), uintptr(b.Top), uintptr(b.Right-b.Left), uintptr(b.Bottom-b.Top), uintptr(window.NativeWindow()), 0, 0, 0)
				if hwnd == 0 {
					done(nil, fmt.Errorf("create child HWND: %w", winErr))
					return
				}
				handler := completed("{6c4819f3-c9b7-4260-8127-c9f5bde7f68c}", func(hr, value uintptr) {
					if int32(hr) < 0 {
						done(nil, fmt.Errorf("controller HRESULT 0x%08x", uint32(hr)))
						return
					}
					controller := (*com)(unsafe.Pointer(value))
					controller.call(1)
					var view *com
					if err := controller.call(25, ptr(&view)); err != nil {
						done(nil, err)
						return
					}
					tabs[cmd.Tab] = &tab{controller, view, hwnd}
					var settings *com
					if err := view.call(3, ptr(&settings)); err != nil {
						done(nil, err)
						return
					}
					defer settings.call(2)
					for _, index := range []int{6, 12, 16} {
						if err := settings.call(index, 0); err != nil {
							done(nil, err)
							return
						}
					}
					localBounds := rect{Right: b.Right - b.Left, Bottom: b.Bottom - b.Top}
					if err := controller.call(6, ptr(&localBounds)); err != nil {
						done(nil, err)
						return
					}
					controller.call(4, 0)
					done(true, view.call(5, ptr(wide(server.URL+"/page"))))
				})
				if err := environment.call(21, hwnd, ptr(options), ptr(handler)); err != nil {
					done(nil, err)
				}
			case "eval", "cdp":
				if t == nil {
					done(nil, fmt.Errorf("unknown tab"))
					return
				}
				iid := "{49511172-cc67-4bca-9923-137112f4c4cc}"
				if cmd.Op == "cdp" {
					iid = "{5c4889f0-5ef6-4c5a-952c-d8f1b92d0574}"
				}
				handler := completed(iid, func(hr, value uintptr) {
					if int32(hr) < 0 {
						done(nil, fmt.Errorf("script HRESULT 0x%08x", uint32(hr)))
						return
					}
					done(windows.UTF16PtrToString((*uint16)(unsafe.Pointer(value))), nil)
				})
				var err error
				if cmd.Op == "cdp" {
					params := string(cmd.Params)
					if params == "" {
						params = "{}"
					}
					err = t.view.call(36, ptr(wide(cmd.Method)), ptr(wide(params)), ptr(handler))
				} else {
					err = t.view.call(29, ptr(wide(cmd.Script)), ptr(handler))
				}
				if err != nil {
					done(nil, err)
				}
			case "visible":
				if t == nil {
					done(nil, fmt.Errorf("unknown tab"))
					return
				}
				v := uintptr(0)
				if cmd.Visible {
					v = 1
				}
				user32.NewProc("ShowWindow").Call(t.hwnd, v*5)
				if cmd.Visible {
					user32.NewProc("SetWindowPos").Call(t.hwnd, 0, 0, 0, 0, 0, 0x0013)
				}
				done(true, t.controller.call(4, v))
			case "bounds":
				if t == nil {
					done(nil, fmt.Errorf("unknown tab"))
					return
				}
				b := cmd.Bounds
				user32.NewProc("SetWindowPos").Call(t.hwnd, 0, uintptr(b.Left), uintptr(b.Top), uintptr(b.Right-b.Left), uintptr(b.Bottom-b.Top), 0x0014)
				localBounds := rect{Right: b.Right - b.Left, Bottom: b.Bottom - b.Top}
				done(true, t.controller.call(6, ptr(&localBounds)))
			case "park":
				if t == nil {
					done(nil, fmt.Errorf("unknown tab"))
					return
				}
				user32.NewProc("ShowWindow").Call(t.hwnd, 0)
				done(true, t.controller.call(4, 1))
			case "settings":
				if t == nil {
					done(nil, fmt.Errorf("unknown tab"))
					return
				}
				var settings *com
				if err := t.view.call(3, ptr(&settings)); err != nil {
					done(nil, err)
					return
				}
				defer settings.call(2)
				values := map[string]int32{}
				for name, index := range map[string]int{"messages": 5, "devtools": 11, "hostObjects": 15} {
					var value int32
					if err := settings.call(index, ptr(&value)); err != nil {
						done(nil, err)
						return
					}
					values[name] = value
				}
				done(values, nil)
			case "focus":
				if t == nil {
					done(nil, fmt.Errorf("unknown tab"))
					return
				}
				done(true, t.controller.call(12, 0))
			case "close":
				if t == nil {
					done(nil, fmt.Errorf("unknown tab"))
					return
				}
				err := t.controller.call(24)
				t.view.call(2)
				t.controller.call(2)
				user32.NewProc("DestroyWindow").Call(t.hwnd)
				delete(tabs, cmd.Tab)
				done(true, err)
			case "modal":
				modal.Store(cmd.Visible)
				done(true, nil)
			case "resize":
				window.SetSize(int(cmd.Bounds.Right), int(cmd.Bounds.Bottom))
				done(true, nil)
			case "hide":
				window.Hide()
				done(true, nil)
			case "show":
				window.Show()
				done(true, nil)
			case "minimize":
				window.Minimise()
				done(true, nil)
			case "restore":
				window.UnMinimise()
				done(true, nil)
			case "quit":
				for id, t := range tabs {
					t.controller.call(24)
					t.view.call(2)
					t.controller.call(2)
					user32.NewProc("DestroyWindow").Call(t.hwnd)
					delete(tabs, id)
				}
				if environment != nil {
					environment.call(2)
					environment = nil
				}
				done(true, nil)
				go func() { time.Sleep(150 * time.Millisecond); app.Quit() }()
			default:
				done(nil, fmt.Errorf("unknown command"))
			}
		})
		select {
		case res := <-out:
			json.NewEncoder(w).Encode(res)
		case <-time.After(25 * time.Second):
			json.NewEncoder(w).Encode(result{Error: "command timeout"})
		}
	})
	app = application.New(application.Options{Name: "StarWeave Browser Gate", Windows: application.WindowsOptions{WebviewUserDataPath: filepath.Join(data, "shell")}})
	window = app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "StarWeave Browser Gate", Width: 1200, Height: 800, URL: server.URL + "/shell"})
	started := false
	window.RegisterHook(events.Windows.WebViewNavigationCompleted, func(*application.WindowEvent) {
		if started {
			return
		}
		started = true
		handler := completed("{4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d}", func(hr, value uintptr) {
			if int32(hr) < 0 {
				ready <- result{Error: fmt.Sprintf("environment HRESULT 0x%08x", uint32(hr))}
				return
			}
			base := (*com)(unsafe.Pointer(value))
			iid, err := windows.GUIDFromString("{ee0eb9df-6f12-46ce-b53f-3f47b9c928e0}")
			if err == nil {
				err = base.call(0, ptr(&iid), ptr(&environment))
			}
			if err != nil {
				ready <- result{Error: err.Error()}
				return
			}
			var version *uint16
			err = environment.call(5, ptr(&version))
			if err != nil {
				ready <- result{Error: err.Error()}
				return
			}
			v := windows.UTF16PtrToString(version)
			windows.NewLazySystemDLL("ole32.dll").NewProc("CoTaskMemFree").Call(ptr(version))
			ready <- result{Value: map[string]any{"runtime": v, "hwnd": uintptr(window.NativeWindow()), "data": data}}
		})
		application.InvokeSync(func() {
			hr, _, _ := create.Call(0, ptr(wide(filepath.Join(data, "browser"))), 0, ptr(handler))
			if int32(hr) < 0 {
				ready <- result{Error: fmt.Sprintf("create HRESULT 0x%08x", uint32(hr))}
			}
		})
	})
	manifest, _ := json.Marshal(map[string]any{"url": server.URL, "token": token, "pid": os.Getpid()})
	if err := os.WriteFile(os.Args[2], manifest, 0600); err != nil {
		log.Fatal(err)
	}
	defer os.Remove(os.Args[2])
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
