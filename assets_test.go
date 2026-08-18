package desktopassets

import (
	"strings"
	"testing"
)

func TestOfflineFrontendEmbedded(t *testing.T) {
	b, err := Frontend.ReadFile("frontend/index.html")
	if err != nil { t.Fatal(err) }
	text := string(b)
	if !strings.Contains(text, "/wails/runtime.js") || strings.Contains(text, "https://") { t.Fatal("frontend is missing Wails runtime or contains a remote dependency") }
}
