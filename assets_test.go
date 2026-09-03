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
	for _, marker := range []string{"core-network", "agent-nodes", "AUTONOMOUS AGENT FABRIC"} {
		if !strings.Contains(text, marker) {
			t.Fatalf("frontend splash is missing StarWeave Core marker %q", marker)
		}
	}
	for _, expected := range []string{"downloadProgress", "downloadPercent", "cancelUpdate", "retryUpdate", "SHA-256"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("frontend update window is missing %q", expected)
		}
	}
	script, err := Frontend.ReadFile("frontend/app.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"desktopUpdate", "bytesPerSecond", "CancelDesktopUpdate", "InstallDesktopUpdate"} {
		if !strings.Contains(string(script), expected) {
			t.Fatalf("frontend update logic is missing %q", expected)
		}
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
	if !strings.Contains(string(styles), "@keyframes starConverge") || !strings.Contains(string(styles), "@keyframes agentPulse") || !strings.Contains(string(styles), "body[data-phase=\"ready\"] .logo-core") {
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

func TestWindowsInstallerIdentityDoesNotMatchApplicationWindow(t *testing.T) {
	data, err := os.ReadFile("build/windows/installer.nsi")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, `Caption "StarWeave 安装"`) {
		t.Fatal("Windows installer must use a caption distinct from the StarWeave application window")
	}
	if !strings.Contains(text, `StarWeaveInstaller.exe`) {
		t.Fatal("Windows installer process must use the StarWeaveInstaller executable name")
	}
	if !strings.Contains(text, `FindWindow $1 "WailsWebviewWindow" "StarWeave"`) {
		t.Fatal("Windows installer must distinguish the StarWeave Wails window from its own NSIS window")
	}
}

func TestWindowsUpdateModeShowsInstallerProgressOnly(t *testing.T) {
	data, err := os.ReadFile("build/windows/installer.nsi")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{
		`!include "FileFunc.nsh"`,
		`${GetOptions} $0 "/UPDATE" $1`,
		`!define MUI_CUSTOMFUNCTION_GUIINIT ConfigureInstallerWindow`,
		`Function ConfigureInstallerWindow`,
		`SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:StarWeave 更新"`,
		`Function SkipNonProgressPageForUpdate`,
		`StrCmp $UpdateMode "1" 0 +2`,
		`!insertmacro MUI_PAGE_INSTFILES`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("Windows update installer is missing %q", expected)
		}
	}
	if strings.Contains(text, "Function .onGUIInit") {
		t.Fatal("Windows installer must use the MUI2 GUI initialization hook instead of redefining .onGUIInit")
	}
}

func TestWindowsRuntimeInstallerCleansPluginDependencySeedsWithEmbeddedNode(t *testing.T) {
	data, err := os.ReadFile("build/windows/install-runtime.ps1")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{
		`function Remove-StalePluginDependencySeeds`,
		`("plugin-dependency-seed-" + [Guid]::NewGuid().ToString("N"))`,
		`require('fs').rmSync(process.argv[1], { recursive: true, force: true`,
		`a later install will retry cleanup`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("Windows runtime installer is missing long-path-safe plugin dependency cleanup marker %q", expected)
		}
	}
	if strings.Contains(text, `Remove-Item -LiteralPath $dependencySeed -Recurse`) {
		t.Fatal("Windows runtime installer must not recursively remove the plugin dependency seed with PowerShell")
	}
}

func TestTrayMenuUsesConciseLabelsInOrder(t *testing.T) {
	data, err := os.ReadFile("cmd/dsh-desktop/main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	position := -1
	for _, label := range []string{"显示", "终端", "更新", "重启", "日志"} {
		next := strings.Index(text[position+1:], `menu.Add("`+label+`")`)
		if next < 0 {
			t.Fatalf("tray menu is missing %q", label)
		}
		position += next + 1
	}
	for _, oldLabel := range []string{"打开 Harness", "打开 dsh 终端", "检查桌面更新", "重启 Harness", "打开日志"} {
		if strings.Contains(text, `menu.Add("`+oldLabel+`")`) {
			t.Fatalf("tray menu still contains %q", oldLabel)
		}
	}
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
