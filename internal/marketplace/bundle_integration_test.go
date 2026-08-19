package marketplace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/update"
)

func TestBundledMarketplaceOfflineInstall(t *testing.T) {
	runtimeDir := os.Getenv("DSH_MARKETPLACE_E2E_RUNTIME")
	bundleDir := os.Getenv("DSH_MARKETPLACE_E2E_BUNDLE")
	node := os.Getenv("DSH_MARKETPLACE_E2E_NODE")
	pnpm := os.Getenv("DSH_MARKETPLACE_E2E_PNPM")
	git := os.Getenv("DSH_MARKETPLACE_E2E_GIT")
	childControl := os.Getenv("DSH_MARKETPLACE_E2E_CHILD_CONTROL")
	if runtimeDir == "" || bundleDir == "" || node == "" || pnpm == "" || git == "" || childControl == "" {
		t.Skip("set DSH_MARKETPLACE_E2E_* to run the bundled Marketplace smoke test")
	}

	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	control, err := os.ReadFile(childControl)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.ChildControl, control, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DSH_DESKTOP_MARKETPLACE_DIR", bundleDir)

	manager, err := New(Options{
		Paths: paths,
		Tools: update.Toolchain{Node: node, PNPM: pnpm, Git: git},
		Log:   os.Stderr,
	})
	if err != nil {
		t.Fatal(err)
	}
	bridge, err := StartBridge(manager)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	manager.SetControl(bridge.URL(), bridge.Token())
	manager.SetRuntime(runtimeDir, "47f943859bef60e4160492346772ded9b24f765a")

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := manager.EnsureBundle(ctx); err != nil {
		t.Fatal(err)
	}
	installed := installedPackageVersion(paths.HarnessHome, "@run-bigpig/dsh-desktop-marketplace")
	if installed == nil || *installed != marketplaceVersion {
		t.Fatalf("installed Marketplace Bundle version = %v", installed)
	}
	if err := manager.runCLI(ctx, paths.HarnessHome, "--profile", "web", "--dump-config"); err != nil {
		t.Fatal(err)
	}
	hostEntry := filepath.Join(paths.HarnessHome, "profiles", "web", "node_modules", "@run-bigpig", "dsh-desktop-marketplace-host", "lib", "index.js")
	probe := `import { pathToFileURL } from 'node:url'; const module = await import(pathToFileURL(process.argv[1]).href); const value = await module.DesktopGateway.prototype.catalog.call({}); if (!value || !Array.isArray(value.plugins)) throw new Error('invalid catalog response'); process.stdout.write(JSON.stringify(value));`
	command := exec.CommandContext(ctx, node, "--input-type=module", "--eval", probe, hostEntry)
	command.Dir = filepath.Join(paths.HarnessHome, "profiles", "web")
	command.Env = manager.commandEnvironment(paths.HarnessHome)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Marketplace Host could not reach desktop bridge: %v\n%s", err, output)
	}
}
