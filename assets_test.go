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
	if !strings.Contains(text, "starweave-logo.png") || strings.Contains(text, "avilo-bird.png") {
		t.Fatal("frontend does not reference the StarWeave startup logo")
	}
	if !strings.Contains(text, "星织启动中") || !strings.Contains(text, "weave-thread") {
		t.Fatal("frontend does not contain the StarWeave convergence splash")
	}
	if _, err := Frontend.ReadFile("frontend/starweave-logo.png"); err != nil {
		t.Fatal(err)
	}
	styles, err := Frontend.ReadFile("frontend/styles.css")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(styles), "--wails-draggable: drag") {
		t.Fatal("frontend splash is missing its draggable region")
	}
}
