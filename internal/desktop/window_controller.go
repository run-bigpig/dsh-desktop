package desktop

import (
	"errors"
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

func (c *windowController) OpenDesignWindow(url string) error {
	c.mu.Lock()
	window := c.designWindow
	if window == nil {
		c.mu.Unlock()
		return errors.New("design window is unavailable")
	}
	reload := c.designURL != url
	c.designURL = url
	c.mu.Unlock()
	if reload {
		window.SetURL(url)
	}
	window.Show()
	window.Restore()
	window.Focus()
	return nil
}
