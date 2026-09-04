package desktop

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"

	"github.com/run-bigpig/dsh-desktop/internal/plugin"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type windowController struct {
	mu           sync.RWMutex
	window       *application.WebviewWindow
	designWindow *application.WebviewWindow
	designURL    string
}

func (c *windowController) SetWindow(window *application.WebviewWindow) {
	c.mu.Lock()
	c.window = window
	c.mu.Unlock()
}

func (c *windowController) SetDesignWindow(window *application.WebviewWindow) {
	c.mu.Lock()
	c.designWindow = window
	c.mu.Unlock()
}

func (c *windowController) current() (*application.WebviewWindow, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.window == nil {
		return nil, errors.New("desktop window is unavailable")
	}
	return c.window, nil
}

func (c *windowController) WindowState() (plugin.WindowState, error) {
	window, err := c.current()
	if err != nil {
		return plugin.WindowState{}, err
	}
	return plugin.WindowState{
		Maximized:  window.IsMaximised(),
		Fullscreen: window.IsFullscreen(),
	}, nil
}

func (c *windowController) MinimizeWindow() error {
	window, err := c.current()
	if err != nil {
		return err
	}
	window.Minimise()
	return nil
}

func (c *windowController) ToggleMaximizeWindow() (plugin.WindowState, error) {
	window, err := c.current()
	if err != nil {
		return plugin.WindowState{}, err
	}
	window.ToggleMaximise()
	return c.WindowState()
}

func (c *windowController) CloseWindow() error {
	window, err := c.current()
	if err != nil {
		return err
	}
	window.Close()
	return nil
}

func (c *windowController) OpenDesignWindow(url string, navigate bool) error {
	c.mu.Lock()
	window := c.designWindow
	if window == nil {
		c.mu.Unlock()
		return errors.New("design window is unavailable")
	}
	reload := navigate || c.designURL == ""
	if reload {
		c.designURL = url
	}
	c.mu.Unlock()
	if reload {
		window.SetURL(url)
	}
	window.Show()
	window.Restore()
	window.Focus()
	return nil
}

func (c *windowController) ChooseDesignSavePath(suggestedName string) (string, error) {
	window, app, err := c.designDialogContext()
	if err != nil {
		return "", err
	}
	path, err := app.Dialog.SaveFile().
		SetFilename(designSaveFilename(suggestedName)).
		AddFilter("OpenPencil Design", "*.fig").
		AttachToWindow(window).
		PromptForSingleSelection()
	if err != nil || path == "" {
		return path, err
	}
	if !strings.EqualFold(filepath.Ext(path), ".fig") {
		path += ".fig"
	}
	return path, nil
}

func (c *windowController) ChooseDesignOpenPath() (string, error) {
	window, app, err := c.designDialogContext()
	if err != nil {
		return "", err
	}
	return app.Dialog.OpenFile().
		AddFilter("OpenPencil Design", "*.fig").
		AttachToWindow(window).
		PromptForSingleSelection()
}

func (c *windowController) designDialogContext() (*application.WebviewWindow, *application.App, error) {
	c.mu.RLock()
	window := c.designWindow
	c.mu.RUnlock()
	if window == nil {
		return nil, nil, errors.New("design window is unavailable")
	}
	app := application.Get()
	if app == nil {
		return nil, nil, errors.New("desktop application is unavailable")
	}
	return window, app, nil
}

func designSaveFilename(value string) string {
	value = strings.TrimSpace(value)
	if index := strings.LastIndexAny(value, `/\\`); index >= 0 {
		value = value[index+1:]
	}
	value = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\\|?*`, r) {
			return '_'
		}
		return r
	}, value)
	value = strings.Trim(value, ". ")
	if value == "" {
		value = "Untitled"
	}
	if !strings.EqualFold(filepath.Ext(value), ".fig") {
		value += ".fig"
	}
	return value
}
