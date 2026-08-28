package desktopassets

import (
	"strings"
	"testing"
)

func TestOfflineFrontendEmbedded(t *testing.T) {
	b, err := Frontend.ReadFile("frontend/index.html")
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	if !strings.Contains(text, "/wails/runtime.js") || strings.Contains(text, "https://") {
		t.Fatal("frontend is missing Wails runtime or contains a remote dependency")
	}
	if !strings.Contains(text, "avilo-bird.png") || strings.Contains(text, "deepseek-fish.svg") {
		t.Fatal("frontend does not reference the Avilo startup logo")
	}
	if _, err := Frontend.ReadFile("frontend/avilo-bird.png"); err != nil {
		t.Fatal(err)
	}
}
