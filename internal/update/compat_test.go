package update

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateToolchain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "package.json")
	data := []byte(`{"packageManager":"pnpm@11.7.0","engines":{"node":"^22.19.0 || >=24.0.0"}}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateToolchain(path, "24.8.0", "11.7.0"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateToolchain(path, "23.1.0", "11.7.0"); err == nil {
		t.Fatal("accepted incompatible Node")
	}
	if err := ValidateToolchain(path, "24.8.0", "10.0.0"); err == nil {
		t.Fatal("accepted incompatible pnpm")
	}
}
