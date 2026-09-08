package browser

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"strings"
)

type Bounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Scale  float64 `json:"scale"`
}
type Command struct {
	Sequence  int64           `json:"sequence,omitempty"`
	Op        string          `json:"op"`
	SessionID string          `json:"sessionId"`
	TabID     string          `json:"tabId"`
	URL       string          `json:"url,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Visible   bool            `json:"visible,omitempty"`
	Bounds    Bounds          `json:"bounds,omitempty"`
}
type Tab struct {
	ID           string `json:"id"`
	URL          string `json:"url"`
	Title        string `json:"title"`
	CanGoBack    bool   `json:"canGoBack"`
	CanGoForward bool   `json:"canGoForward"`
}
type Controller interface {
	Execute(context.Context, Command) (any, error)
	Reset()
}

func ValidURL(raw string) bool {
	if raw == "about:blank" {
		return true
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && !strings.ContainsRune(raw, 0)
}
func (c Command) Validate() error {
	if c.SessionID == "" || len(c.SessionID) > 512 || strings.ContainsRune(c.SessionID, 0) {
		return errors.New("browser session identity is required")
	}
	switch c.Op {
	case "list", "remove-session":
		return nil
	case "create", "navigate":
		if !ValidURL(c.URL) {
			return errors.New("browser URL must use http or https")
		}
	case "layout":
		b := c.Bounds
		for _, n := range []float64{b.X, b.Y, b.Width, b.Height, b.Scale} {
			if math.IsNaN(n) || math.IsInf(n, 0) {
				return errors.New("invalid browser bounds")
			}
		}
		if c.Visible && (b.X < 0 || b.Y < 0 || b.Width < 1 || b.Height < 1 || b.Width > 16000 || b.Height > 16000 || b.Scale < 0.25 || b.Scale > 8) {
			return errors.New("invalid browser bounds")
		}
	case "cdp":
		// Keep automation on this WebView target; browser-level commands can escape its Profile.
		if strings.ContainsRune(c.Method, 0) {
			return errors.New("invalid CDP method")
		}
		domain, _, _ := strings.Cut(c.Method, ".")
		switch domain {
		case "DOM", "DOMSnapshot", "Accessibility", "Runtime", "Input":
		case "Page":
			if c.Method != "Page.captureScreenshot" && c.Method != "Page.getLayoutMetrics" {
				return errors.New("unsupported page command; use browser navigation")
			}
		default:
			return errors.New("unsupported browser CDP domain")
		}
		if len(c.Params) > 0 && !json.Valid(c.Params) {
			return errors.New("invalid CDP parameters")
		}
	case "back", "forward", "reload", "close":
	default:
		return errors.New("unknown browser command")
	}
	if c.TabID == "" || len(c.TabID) > 128 || strings.ContainsRune(c.TabID, 0) {
		return errors.New("browser tab identity is required")
	}
	return nil
}
