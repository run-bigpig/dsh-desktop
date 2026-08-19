package desktop

import (
	"errors"
	"sync"

	"github.com/run-bigpig/dsh-desktop/internal/marketplace"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type windowController struct {
	mu     sync.RWMutex
	window *application.WebviewWindow
}

func (c *windowController) SetWindow(window *application.WebviewWindow) {
	c.mu.Lock()
	c.window = window
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

func (c *windowController) WindowState() (marketplace.WindowState, error) {
	window, err := c.current()
	if err != nil {
		return marketplace.WindowState{}, err
	}
	return marketplace.WindowState{
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

func (c *windowController) ToggleMaximizeWindow() (marketplace.WindowState, error) {
	window, err := c.current()
	if err != nil {
		return marketplace.WindowState{}, err
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
