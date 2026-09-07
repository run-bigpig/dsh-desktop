package browser

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

type rect struct{ Left, Top, Right, Bottom int32 }
type nativeTab struct {
	navigationURL    string
	controller, view *com
	hwnd             uintptr
	closing          bool
}
type reply struct {
	value any
	err   error
}

var user32 = windows.NewLazySystemDLL("user32.dll")

type Manager struct {
	saved     map[string][]Tab
	savedJSON string

	root, loaderPath string
	window           func() unsafe.Pointer
	once             sync.Once
	ready            chan struct{}
	initErr          error
	environment      *com
	loader           *windows.DLL
	// The fields below are exclusively accessed on the Wails UI thread.
	tabs           map[string]map[string]*nativeTab
	generation     uint64
	visible        *nativeTab
	lastLayout     time.Time
	layoutSequence int64
}

func New(root, loader string, window func() unsafe.Pointer) *Manager {
	return &Manager{root: root, loaderPath: loader, window: window, ready: make(chan struct{}), tabs: make(map[string]map[string]*nativeTab)}
}
func (m *Manager) initialize() {
	if err := os.MkdirAll(m.root, 0700); err != nil {
		m.initErr = err
		close(m.ready)
		return
	}
	loader, err := windows.LoadDLL(m.loaderPath)
	if err != nil {
		m.initErr = fmt.Errorf("load packaged WebView2 loader: %w", err)
		close(m.ready)
		return
	}
	create, err := loader.FindProc("CreateCoreWebView2EnvironmentWithOptions")
	if err != nil {
		loader.Release()
		m.initErr = err
		close(m.ready)
		return
	}
	m.saved = make(map[string][]Tab)
	if data, readErr := os.ReadFile(filepath.Join(m.root, "tabs.json")); readErr == nil {
		if err := json.Unmarshal(data, &m.saved); err != nil {
			loader.Release()
			m.initErr = fmt.Errorf("read browser tab state: %w", err)
			close(m.ready)
			return
		}
		m.savedJSON = string(data)
	} else if !os.IsNotExist(readErr) {
		loader.Release()
		m.initErr = readErr
		close(m.ready)
		return
	}
	m.loader = loader
	application.InvokeAsync(func() {
		handler := completed("{4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d}", func(hr, value uintptr) {
			if int32(hr) < 0 {
				m.initErr = fmt.Errorf("browser environment HRESULT 0x%08x", uint32(hr))
			} else {
				base := (*com)(unsafe.Pointer(value))
				iid, _ := windows.GUIDFromString("{ee0eb9df-6f12-46ce-b53f-3f47b9c928e0}")
				m.initErr = base.call(0, ptr(&iid), ptr(&m.environment))
			}
			close(m.ready)
		})
		defer handler.release()
		hr, _, _ := create.Call(0, ptr(wide(m.root)), 0, ptr(handler))
		if int32(hr) < 0 {
			m.initErr = fmt.Errorf("create browser environment HRESULT 0x%08x", uint32(hr))
			close(m.ready)
		}
	})
}
func (m *Manager) Execute(ctx context.Context, c Command) (any, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	m.once.Do(m.initialize)
	select {
	case <-m.ready:
		if m.initErr != nil {
			return nil, m.initErr
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	out := make(chan reply, 1)
	done := func(value any, err error) {
		select {
		case out <- reply{value, err}:
		default:
		}
	}
	application.InvokeAsync(func() {
		if ctx.Err() != nil {
			done(nil, ctx.Err())
			return
		}
		m.execute(ctx, c, done)
	})
	select {
	case r := <-out:
		return r.value, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (m *Manager) execute(ctx context.Context, c Command, done func(any, error)) {
	session := m.tabs[c.SessionID]
	t := session[c.TabID]
	if session == nil && len(m.saved[c.SessionID]) > 0 && c.Op != "list" && c.Op != "remove-session" {
		m.execute(ctx, Command{Op: "list", SessionID: c.SessionID}, func(_ any, err error) {
			if err != nil {
				done(nil, err)
				return
			}
			m.execute(ctx, c, done)
		})
		return
	}
	switch c.Op {
	case "create":
		if t != nil {
			done(nil, errors.New("browser tab already exists"))
			return
		}
		if session == nil {
			session = make(map[string]*nativeTab)
			m.tabs[c.SessionID] = session
		}
		m.create(ctx, c, done)
		return
	case "list":
		if session == nil && len(m.saved[c.SessionID]) > 0 {
			saved := m.saved[c.SessionID]
			m.tabs[c.SessionID] = make(map[string]*nativeTab)
			remaining := len(saved)
			var failure error
			for _, record := range saved {
				restore := Command{Op: "create", SessionID: c.SessionID, TabID: record.ID, URL: record.URL}
				if !ValidURL(restore.URL) {
					restore.URL = "about:blank"
				}
				m.create(ctx, restore, func(_ any, err error) {
					if err != nil {
						failure = err
					}
					remaining--
					if remaining == 0 {
						if failure != nil {
							done(nil, failure)
						} else {
							m.execute(ctx, c, done)
						}
					}
				})
			}
			return
		}
		result := make([]Tab, 0, len(session))
		pending := false
		for id, view := range session {
			if view.view == nil {
				pending = true
				continue
			}
			value, err := snapshot(id, view)
			if err != nil {
				done(nil, err)
				return
			}
			result = append(result, value)
		}
		sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
		if !pending {
			m.saved[c.SessionID] = result
			if err := m.persist(); err != nil {
				done(nil, err)
				return
			}
		}
		done(result, nil)
		return
	case "remove-session":
		m.remove(c.SessionID)
		delete(m.saved, c.SessionID)
		done(true, m.persist())
		return
	}
	if t == nil || t.view == nil {
		done(nil, errors.New("browser tab is unavailable"))
		return
	}
	switch c.Op {
	case "layout":
		if c.Sequence <= m.layoutSequence {
			done(true, nil)
			return
		}
		m.layoutSequence = c.Sequence
		if m.visible != nil && (m.visible != t || !c.Visible) {
			user32.NewProc("ShowWindow").Call(m.visible.hwnd, 0)
			m.visible = nil
		}
		if !c.Visible {
			done(true, nil)
			return
		}
		b := c.Bounds
		x, y, w, h := int32(b.X*b.Scale), int32(b.Y*b.Scale), int32(b.Width*b.Scale), int32(b.Height*b.Scale)
		// Clamp to the actual client rect during in-flight resize events.
		var parent rect
		user32.NewProc("GetClientRect").Call(uintptr(m.window()), ptr(&parent))
		if x+w > parent.Right {
			w = parent.Right - x
		}
		if y+h > parent.Bottom {
			h = parent.Bottom - y
		}
		if w < 1 || h < 1 {
			done(true, nil)
			return
		}
		bounds := rect{Right: w, Bottom: h}
		if err := t.controller.call(6, ptr(&bounds)); err != nil {
			done(nil, err)
			return
		}
		user32.NewProc("SetWindowPos").Call(t.hwnd, 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h), 0x0010)
		user32.NewProc("ShowWindow").Call(t.hwnd, 5)
		m.visible = t
		m.lastLayout = time.Now()
		// Stale chrome cannot leave a native view over a different Harness screen.
		lease := m.lastLayout
		time.AfterFunc(3*time.Second, func() {
			application.InvokeAsync(func() {
				if m.visible == t && m.lastLayout == lease {
					user32.NewProc("ShowWindow").Call(t.hwnd, 0)
					m.visible = nil
				}
			})
		})
		done(true, nil)
	case "navigate":
		if err := t.view.call(5, ptr(wide(c.URL))); err != nil {
			done(nil, err)
			return
		}
		t.navigationURL = c.URL
		for i, record := range m.saved[c.SessionID] {
			if record.ID == c.TabID {
				m.saved[c.SessionID][i].URL = c.URL
			}
		}
		done(true, m.persist())
	case "back":
		done(true, t.view.call(40))
	case "forward":
		done(true, t.view.call(41))
	case "reload":
		done(true, t.view.call(31))
	case "close":
		m.closeTab(c.SessionID, c.TabID)
		m.execute(ctx, Command{Op: "list", SessionID: c.SessionID}, func(_ any, err error) { done(true, err) })
	case "cdp":
		params := string(c.Params)
		if params == "" {
			params = "{}"
		}
		handler := completed("{5c4889f0-5ef6-4c5a-952c-d8f1b92d0574}", func(hr, value uintptr) {
			if int32(hr) < 0 {
				done(nil, fmt.Errorf("browser CDP HRESULT 0x%08x", uint32(hr)))
				return
			}
			raw := windows.UTF16PtrToString((*uint16)(unsafe.Pointer(value)))
			if !json.Valid([]byte(raw)) {
				done(nil, errors.New("invalid browser CDP response"))
				return
			}
			done(json.RawMessage(raw), nil)
		})
		defer handler.release()
		if err := t.view.call(36, ptr(wide(c.Method)), ptr(wide(params)), ptr(handler)); err != nil {
			done(nil, err)
		}
	}
}
func (m *Manager) create(ctx context.Context, c Command, done func(any, error)) {
	parent := m.window()
	if parent == nil {
		done(nil, errors.New("desktop window is unavailable"))
		return
	}
	var options *com
	if err := m.environment.call(20, ptr(&options)); err != nil {
		done(nil, err)
		return
	}
	defer options.call(2)
	digest := sha256.Sum256([]byte(c.SessionID))
	profile := hex.EncodeToString(digest[:])
	if err := options.call(4, ptr(wide(profile))); err != nil {
		done(nil, err)
		return
	}
	hwnd, _, err := user32.NewProc("CreateWindowExW").Call(0, ptr(wide("STATIC")), 0, 0x40000000|0x04000000|0x02000000, 0, 0, 1000, 800, uintptr(parent), 0, 0, 0)
	if hwnd == 0 {
		done(nil, fmt.Errorf("create browser child: %w", err))
		return
	}
	pending := &nativeTab{hwnd: hwnd, navigationURL: c.URL}
	m.tabs[c.SessionID][c.TabID] = pending
	generation := m.generation
	handler := completed("{6c4819f3-c9b7-4260-8127-c9f5bde7f68c}", func(hr, value uintptr) {
		fail := func(err error) { m.closeTab(c.SessionID, c.TabID); done(nil, err) }
		if int32(hr) < 0 {
			fail(fmt.Errorf("browser controller HRESULT 0x%08x", uint32(hr)))
			return
		}
		controller := (*com)(unsafe.Pointer(value))
		controller.call(1)
		if generation != m.generation || pending.closing || ctx.Err() != nil {
			controller.call(24)
			controller.call(2)
			if !pending.closing {
				fail(errors.New("browser creation cancelled"))
			} else {
				done(nil, errors.New("browser creation cancelled"))
			}
			return
		}
		pending.controller = controller
		if err := controller.call(25, ptr(&pending.view)); err != nil {
			fail(err)
			return
		}
		var settings *com
		if err := pending.view.call(3, ptr(&settings)); err != nil {
			fail(err)
			return
		}
		defer settings.call(2)
		for _, index := range []int{6, 12, 16} {
			if err := settings.call(index, 0); err != nil {
				fail(err)
				return
			}
		}
		if err := m.navigationGuards(pending); err != nil {
			fail(err)
			return
		}
		bounds := rect{Right: 1000, Bottom: 800}
		if err := controller.call(6, ptr(&bounds)); err != nil {
			fail(err)
			return
		}
		// The child HWND remains hidden. Keep rendering enabled for background CDP screenshots.
		if err := controller.call(4, 1); err != nil {
			fail(err)
			return
		}
		if err := pending.view.call(5, ptr(wide(c.URL))); err != nil {
			fail(err)
			return
		}
		record := Tab{ID: c.TabID, URL: c.URL, Title: c.URL}
		found := false
		for i, item := range m.saved[c.SessionID] {
			if item.ID == c.TabID {
				m.saved[c.SessionID][i] = record
				found = true
				break
			}
		}
		if !found {
			m.saved[c.SessionID] = append(m.saved[c.SessionID], record)
		}
		done(record, m.persist())
	})
	defer handler.release()
	if err := m.environment.call(21, hwnd, ptr(options), ptr(handler)); err != nil {
		m.closeTab(c.SessionID, c.TabID)
		done(nil, err)
	}
}
func (m *Manager) navigationGuards(t *nativeTab) error {
	nav := completed("{9adbe429-f36d-432b-9ddc-f8881fbd76e3}", func(_, value uintptr) {
		args := (*com)(unsafe.Pointer(value))
		uri, err := comString(args, 3)
		if err != nil || !ValidURL(uri) {
			args.call(8, 1)
		} else {
			t.navigationURL = uri
		}
	})
	defer nav.release()
	var token int64
	if err := t.view.call(7, ptr(nav), ptr(&token)); err != nil {
		return err
	}
	popup := completed("{d4c185fe-c81c-4989-97af-2d3fa7ab5651}", func(_, value uintptr) {
		args := (*com)(unsafe.Pointer(value))
		args.call(6, 1)
		// Keep target=_blank links in this session-owned view, without unmanaged windows.
		uri, err := comString(args, 3)
		if err == nil && ValidURL(uri) {
			t.view.call(5, ptr(wide(uri)))
		}
	})
	defer popup.release()
	return t.view.call(44, ptr(popup), ptr(&token))
}
func comString(c *com, index int) (string, error) {
	var value *uint16
	if err := c.call(index, ptr(&value)); err != nil {
		return "", err
	}
	defer windows.NewLazySystemDLL("ole32.dll").NewProc("CoTaskMemFree").Call(ptr(value))
	return windows.UTF16PtrToString(value), nil
}
func snapshot(id string, t *nativeTab) (Tab, error) {
	uri, err := comString(t.view, 4)
	if err != nil {
		return Tab{}, err
	}
	if uri == "about:blank" && t.navigationURL != "" {
		uri = t.navigationURL
	}
	title, err := comString(t.view, 48)
	if err != nil {
		return Tab{}, err
	}
	var back, forward int32
	if err = t.view.call(38, ptr(&back)); err != nil {
		return Tab{}, err
	}
	if err = t.view.call(39, ptr(&forward)); err != nil {
		return Tab{}, err
	}
	return Tab{ID: id, URL: uri, Title: title, CanGoBack: back != 0, CanGoForward: forward != 0}, nil
}
func (m *Manager) closeTab(session, id string) {
	t := m.tabs[session][id]
	if t == nil {
		return
	}
	t.closing = true
	if m.visible == t {
		m.visible = nil
	}
	if t.controller != nil {
		t.controller.call(24)
	}
	if t.view != nil {
		t.view.call(2)
	}
	if t.controller != nil {
		t.controller.call(2)
	}
	user32.NewProc("DestroyWindow").Call(t.hwnd)
	delete(m.tabs[session], id)
}
func (m *Manager) remove(session string) {
	for id := range m.tabs[session] {
		m.closeTab(session, id)
	}
	delete(m.tabs, session)
}
func (m *Manager) Reset() {
	select {
	case <-m.ready:
		if m.initErr != nil {
			return
		}
	default:
		return
	}
	application.InvokeSync(func() {
		m.generation++
		m.layoutSequence = 0
		for session := range m.tabs {
			m.remove(session)
		}
	})
}

func (m *Manager) persist() error {
	data, err := json.Marshal(m.saved)
	if err != nil {
		return err
	}
	if string(data) == m.savedJSON {
		return nil
	}
	target := filepath.Join(m.root, "tabs.json")
	if err := os.WriteFile(target+".tmp", data, 0600); err != nil {
		return fmt.Errorf("save browser tabs: %w", err)
	}
	if err := os.Rename(target+".tmp", target); err != nil {
		return fmt.Errorf("activate browser tabs: %w", err)
	}
	m.savedJSON = string(data)
	return nil
}
