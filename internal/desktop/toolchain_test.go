package desktop

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
)

func TestResolveToolchainDoesNotRequireGit(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	name := func(value string) string {
		if runtime.GOOS == "windows" {
			return value + ".exe"
		}
		return value
	}
	for _, path := range []string{
		filepath.Join(paths.Toolchain, "node", name("node")),
		filepath.Join(paths.Toolchain, "pnpm", name("pnpm")),
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	tools, err := ResolveToolchain(paths)
	if err != nil {
		t.Fatal(err)
	}
	if tools.Git != "" {
		t.Fatalf("Git = %q, want no runtime Git dependency", tools.Git)
	}
}

func TestInstallBundledToolchainDetachesLegacyGit(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	name := func(value string) string {
		if runtime.GOOS == "windows" {
			return value + ".exe"
		}
		return value
	}
	for _, path := range []string{
		filepath.Join(paths.Toolchain, "node", name("node")),
		filepath.Join(paths.Toolchain, "pnpm", name("pnpm")),
		filepath.Join(paths.Toolchain, "git", "legacy-file"),
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := installBundledToolchain(paths); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(paths.Toolchain, "git")); !os.IsNotExist(err) {
		t.Fatalf("legacy Git directory was not detached: %v", err)
	}
}
