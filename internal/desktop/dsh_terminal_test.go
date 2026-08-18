package desktop

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/deepseek-ai/deepseek-harness-desktop/internal/appconfig"
	"github.com/deepseek-ai/deepseek-harness-desktop/internal/state"
	"github.com/deepseek-ai/deepseek-harness-desktop/internal/update"
)

func TestDSHTerminalConfigUsesActiveRuntime(t *testing.T) {
	root := t.TempDir()
	paths := appconfig.NewPaths(root)
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	commit := "47f943859bef60e4160492346772ded9b24f765a"
	runtimeDir, err := paths.Runtime(commit)
	if err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(runtimeDir, "apps", "cli", "lib", "bin.js")
	if err := os.MkdirAll(filepath.Dir(cli), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cli, []byte("// built CLI"), 0o600); err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(root, "node")
	if err := os.WriteFile(node, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	store := state.NewStore(paths.State)
	if err := store.SaveActive(state.ActiveState{Current: state.RuntimeRef{Commit: commit}}); err != nil {
		t.Fatal(err)
	}
	coordinator := &Coordinator{
		paths: paths,
		cfg:   appconfig.Config{WorkingDirectory: paths.Workspaces},
		store: store,
		tools: update.Toolchain{Node: node},
	}

	config, err := coordinator.dshTerminalConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Node != node || config.CLI != cli || config.HarnessHome != paths.HarnessHome || config.WorkingDirectory != paths.Workspaces || config.StateDirectory != paths.State {
		t.Fatalf("unexpected terminal config: %+v", config)
	}
}

func TestDSHTerminalConfigRequiresActiveRuntime(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	coordinator := &Coordinator{paths: paths, store: state.NewStore(paths.State)}
	if _, err := coordinator.dshTerminalConfig(); err == nil {
		t.Fatal("expected missing active runtime to fail")
	}
}
