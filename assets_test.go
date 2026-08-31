package desktopassets

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/png"
	"os"
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
	if !strings.Contains(text, "星织启动中") || !strings.Contains(text, "star-particle") {
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
	if !strings.Contains(string(styles), "@keyframes starConverge") || !strings.Contains(string(styles), "body[data-phase=\"ready\"] .logo-core") {
		t.Fatal("frontend splash is missing rotating convergence or success logo reveal")
	}
}

func TestApplicationIconFillsThirtyPixelsAtCommonTraySize(t *testing.T) {
	icon, err := png.Decode(bytes.NewReader(AppIcon))
	if err != nil {
		t.Fatal(err)
	}
	assertVisibleSize(t, icon, 32, 30)
}

func TestWindowsIconContainsLargeThirtyPixelMark(t *testing.T) {
	data, err := os.ReadFile("build/windows/icon.ico")
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 6 || binary.LittleEndian.Uint16(data[2:4]) != 1 {
		t.Fatal("invalid Windows icon header")
	}
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	for index := 0; index < count; index++ {
		entry := 6 + index*16
		if entry+16 > len(data) {
			t.Fatal("truncated Windows icon directory")
		}
		width := int(data[entry])
		if width == 0 {
			width = 256
		}
		if width != 32 {
			continue
		}
		size := int(binary.LittleEndian.Uint32(data[entry+8 : entry+12]))
		offset := int(binary.LittleEndian.Uint32(data[entry+12 : entry+16]))
		if offset < 0 || size <= 0 || offset+size > len(data) {
			t.Fatal("invalid Windows icon image entry")
		}
		icon, err := png.Decode(bytes.NewReader(data[offset : offset+size]))
		if err != nil {
			t.Fatal(err)
		}
		assertVisibleSize(t, icon, 32, 30)
		return
	}
	t.Fatal("Windows icon is missing its 32x32 image")
}

func assertVisibleSize(t *testing.T, icon image.Image, targetSize, minimumVisible int) {
	t.Helper()
	bounds := icon.Bounds()
	minX, minY, maxX, maxY := bounds.Max.X, bounds.Max.Y, bounds.Min.X-1, bounds.Min.Y-1
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			_, _, _, alpha := icon.At(x, y).RGBA()
			if alpha <= 0x0808 {
				continue
			}
			if x < minX {
				minX = x
			}
			if x > maxX {
				maxX = x
			}
			if y < minY {
				minY = y
			}
			if y > maxY {
				maxY = y
			}
		}
	}
	visibleWidth, visibleHeight := maxX-minX+1, maxY-minY+1
	if visibleWidth*targetSize < bounds.Dx()*minimumVisible || visibleHeight*targetSize < bounds.Dy()*minimumVisible {
		t.Fatalf("icon remains too small at %dpx: visible bounds %dx%d in %dx%d", targetSize, visibleWidth, visibleHeight, bounds.Dx(), bounds.Dy())
	}
}
