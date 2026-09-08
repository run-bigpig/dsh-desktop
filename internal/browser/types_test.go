package browser

import "testing"

func TestBrowserCommandBoundaries(t *testing.T) {
	for _, url := range []string{"https://example.com", "http://127.0.0.1:1234/", "about:blank"} {
		if !ValidURL(url) {
			t.Errorf("rejected %s", url)
		}
	}
	for _, url := range []string{"file:///C:/secret", "javascript:alert(1)", "ms-settings:display", "https://", "https://example.com\x00"} {
		if ValidURL(url) {
			t.Errorf("accepted %q", url)
		}
	}
	for _, method := range []string{"Browser.close", "Target.createTarget", "Storage.clearDataForOrigin", "Page.navigate", "Runtime.evaluate\x00"} {
		if (Command{Op: "cdp", SessionID: "a", TabID: "one", Method: method}).Validate() == nil {
			t.Errorf("accepted %q", method)
		}
	}
	if err := (Command{Op: "cdp", SessionID: "a", TabID: "one", Method: "Page.captureScreenshot"}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (Command{Op: "layout", SessionID: "a", TabID: "one", Visible: true, Bounds: Bounds{Width: 800, Height: 600, Scale: 1.5}}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (Command{Op: "layout", SessionID: "a", TabID: "one", Visible: true, Bounds: Bounds{Width: 800, Height: 600}}).Validate(); err == nil {
		t.Fatal("accepted visible bounds with zero scale")
	}
}
