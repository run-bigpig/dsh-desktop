package desktop

import (
	"strings"
	"testing"

	"github.com/run-bigpig/dsh-desktop/internal/state"
)

func TestDesktopUpdateMessageIncludesSizeAndReleaseNotes(t *testing.T) {
	message := desktopUpdateMessage(&state.DesktopUpdate{
		Version:      "0.3.0",
		Size:         66 << 20,
		ReleaseNotes: "修复更新流程",
	})
	for _, expected := range []string{"StarWeave 0.3.0", "66.0 MiB", "修复更新流程", "Harness 私有数据会保留"} {
		if !strings.Contains(message, expected) {
			t.Fatalf("update message is missing %q: %s", expected, message)
		}
	}
}

func TestDesktopUpdateMessageLimitsReleaseNotes(t *testing.T) {
	message := desktopUpdateMessage(&state.DesktopUpdate{Version: "0.3.0", ReleaseNotes: strings.Repeat("更", 900)})
	if !strings.HasSuffix(message, strings.Repeat("更", 800)+"…") {
		t.Fatal("release notes were not limited to 800 runes")
	}
}
