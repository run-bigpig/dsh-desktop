package desktop

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/plugin"
)

func TestHarnessEnvironmentPersistsDesignStateAcrossLaunches(t *testing.T) {
	t.Setenv("STARWEAVE_DESIGN_STATE_DIR", filepath.Join(t.TempDir(), "wrong-inherited-state"))
	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	c := &Coordinator{paths: paths, pluginBridge: &plugin.Bridge{}}
	// The child receives the same inherited-plus-desktop environment as Harness.
	for range 2 {
		command := exec.Command(os.Args[0], "-test.run=^TestHarnessDesignStateChild$")
		command.Env = append(os.Environ(), c.harnessEnvironment()...)
		command.Env = append(command.Env, "STARWEAVE_TEST_DESIGN_CHILD=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("design state child: %v\n%s", err, output)
		}
	}
	data, err := os.ReadFile(filepath.Join(paths.State, "design-state-test.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "saved\nsaved\n" {
		t.Fatalf("state did not survive relaunch: %q", data)
	}
}

func TestHarnessDesignStateChild(t *testing.T) {
	if os.Getenv("STARWEAVE_TEST_DESIGN_CHILD") != "1" {
		return
	}
	root := os.Getenv("STARWEAVE_DESIGN_STATE_DIR")
	if root == "" {
		t.Fatal("design persistence directory is missing")
	}
	file, err := os.OpenFile(filepath.Join(root, "design-state-test.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("saved\n"); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}
