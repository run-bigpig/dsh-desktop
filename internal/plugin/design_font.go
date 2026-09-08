package plugin

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

// DesignFontScript exposes only a read-only font capability, never the desktop
// control token or a filesystem path. Wails executes it after each navigation.
func (b *Bridge) DesignFontScript(harnessURL string) (string, error) {
	if runtime.GOOS != "windows" {
		return "", nil
	}
	u, err := url.Parse(harnessURL)
	if err != nil {
		return "", fmt.Errorf("invalid design font origin: %w", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil {
		return "", fmt.Errorf("design font origin must be a loopback Harness URL")
	}
	origin := "http://" + u.Host
	b.mu.Lock()
	b.fontOrigin = origin
	b.mu.Unlock()
	config, err := json.Marshal(map[string]string{"origin": origin, "url": b.url + "v1/design/font", "token": b.fontToken})
	if err != nil {
		return "", err
	}
	return `(function(config) {
  if (location.origin !== config.origin || window !== window.top) return;
  if (window.__STARWEAVE_DESIGN_FONTS__) return;
  let pending;
  const fonts = Object.freeze({ family: 'SimHei', load() {
    if (!pending) pending = fetch(config.url, {
      headers: { Authorization: 'Bearer ' + config.token },
      credentials: 'omit', signal: AbortSignal.timeout(15000)
    }).then(response => {
      if (!response.ok) throw new Error('桌面中文字体加载失败 (' + response.status + ')');
      return response.arrayBuffer();
    }).catch(error => { pending = undefined; throw error; });
    return pending;
  }});
  Object.defineProperty(window, '__STARWEAVE_DESIGN_FONTS__', { value: fonts });
  window.dispatchEvent(new Event('starweave:design-fonts-ready'));
})(` + string(config) + `);`, nil
}

func (b *Bridge) serveDesignFont(w http.ResponseWriter, r *http.Request) {
	b.mu.RLock()
	origin := b.fontOrigin
	b.mu.RUnlock()
	if origin == "" || r.Header.Get("Origin") != origin {
		writeError(w, http.StatusForbidden, "design font origin is not allowed")
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	wanted := "Bearer " + b.fontToken
	if b.fontToken == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(wanted)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, OPTIONS")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	// SimHei is a static TrueType CJK face shipped by Windows. Read it locally;
	// never redistribute the system font in the plugin, installer or document.
	if runtime.GOOS != "windows" || os.Getenv("WINDIR") == "" {
		writeError(w, http.StatusNotFound, "Windows Chinese font is unavailable")
		return
	}
	font, err := os.Open(filepath.Join(os.Getenv("WINDIR"), "Fonts", "simhei.ttf"))
	if err != nil {
		writeError(w, http.StatusNotFound, "Windows SimHei font is unavailable")
		return
	}
	defer font.Close()
	info, err := font.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "cannot read Windows SimHei font")
		return
	}
	w.Header().Set("Content-Type", "font/ttf")
	http.ServeContent(w, r, "simhei.ttf", info.ModTime(), font)
}
