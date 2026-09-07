package desktop

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/plugin"
	"github.com/run-bigpig/dsh-desktop/internal/update"
)

func TestResolveToolchainDoesNotRequireGit(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	t.Setenv("PATH", t.TempDir())
	name := func(value string) string {
		if runtime.GOOS == "windows" {
			return value + ".exe"
		}
		return value
	}
	for _, path := range []string{
		filepath.Join(paths.Toolchain, "node", name("node")),
		filepath.Join(paths.Toolchain, "pnpm", name("pnpm")),
		filepath.Join(paths.Toolchain, "uv", name("uv")),
		filepath.Join(paths.Toolchain, "uv", name("uvx")),
		filepath.Join(paths.Toolchain, "uv", name("uvw")),
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
	if tools.UV != filepath.Join(paths.Toolchain, "uv", name("uv")) || tools.UVVersion != "0.12.10" {
		t.Fatalf("uv must resolve from the locked embedded toolchain: %+v", tools)
	}
	if err := os.Remove(filepath.Join(paths.Toolchain, "uv", name("uvx"))); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveToolchain(paths); err == nil {
		t.Fatal("incomplete uv distribution accepted")
	}
}

func TestHarnessEnvironmentExposesEmbeddedUVWithoutChangingSystemPath(t *testing.T) {
	t.Setenv("PATH", "system-path")
	root := t.TempDir()
	c := &Coordinator{tools: update.Toolchain{Node: filepath.Join(root, "node", "node.exe"), UV: filepath.Join(root, "uv", "uv.exe")}, pluginBridge: &plugin.Bridge{}}
	want := strings.Join([]string{filepath.Join(root, "node"), filepath.Join(root, "uv"), "system-path"}, string(os.PathListSeparator))
	for _, value := range c.harnessEnvironment() {
		if strings.HasPrefix(value, "PATH=") {
			if strings.TrimPrefix(value, "PATH=") != want {
				t.Fatal("embedded uv directory missing from Harness PATH")
			}
			if os.Getenv("PATH") != "system-path" {
				t.Fatal("system PATH was changed")
			}
			return
		}
	}
	t.Fatal("Harness PATH is missing")
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
		filepath.Join(paths.Toolchain, "uv", name("uv")),
		filepath.Join(paths.Toolchain, "uv", name("uvx")),
		filepath.Join(paths.Toolchain, "uv", name("uvw")),
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
