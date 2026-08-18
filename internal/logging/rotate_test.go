package logging

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestRotatingWriter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "desktop.log")
	w, err := NewRotatingWriter(path, 1024, 2)
	if err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("x"), 700)
	if _, err = w.Write(chunk); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write(chunk); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("rotation file missing: %v", err)
	}
}
