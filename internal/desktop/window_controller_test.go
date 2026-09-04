package desktop

import "testing"

func TestDesignSaveFilename(t *testing.T) {
	for input, expected := range map[string]string{
		"Landing":                  "Landing.fig",
		"Canvas.fig":               "Canvas.fig",
		`C:\\unsafe\\bad:name.fig`: "bad_name.fig",
		"   ":                      "Untitled.fig",
	} {
		if actual := designSaveFilename(input); actual != expected {
			t.Fatalf("designSaveFilename(%q) = %q, want %q", input, actual, expected)
		}
	}
}
