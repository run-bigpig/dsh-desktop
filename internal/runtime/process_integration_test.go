//go:build !windows

package runtime

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/run-bigpig/dsh-desktop/internal/state"
)

func TestNodeFixtureGracefulShutdownAndUnexpectedExit(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	control, err := filepath.Abs(filepath.Join("..", "desktop", "child-control.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name      string
		exitAfter bool
	}{{"graceful", false}, {"unexpected", true}} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			cliDir := filepath.Join(root, "apps", "cli", "lib")
			if err := os.MkdirAll(cliDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"type":"module"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			script := `import http from "node:http";
const server=http.createServer((req,res)=>{res.end('<script>window.__DSH_BOOT__={}</script>')});
server.listen(0,"127.0.0.1",()=>{console.log("dsh web: http://127.0.0.1:"+server.address().port);` + func() string {
				if tc.exitAfter {
					return `setTimeout(()=>process.exit(23),250);`
				}
				return ""
			}() + `});
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`
			if err := os.WriteFile(filepath.Join(cliDir, "bin.js"), []byte(script), 0o600); err != nil {
				t.Fatal(err)
			}
			store := state.NewStore(filepath.Join(root, "state"))
			p := NewProcess(LaunchConfig{Node: node, ChildControl: control, RuntimeDir: root, HarnessHome: filepath.Join(root, "home"), WorkingDir: root, StartupTimeout: 4 * time.Second, ShutdownTimeout: 2 * time.Second}, store, os.Stderr)
			if _, err := p.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			if tc.exitAfter {
				deadline := time.Now().Add(3 * time.Second)
				for time.Now().Before(deadline) && store.Snapshot().Phase != state.Failed {
					time.Sleep(20 * time.Millisecond)
				}
				if store.Snapshot().Phase != state.Failed {
					t.Fatal("unexpected exit was not observed")
				}
				return
			}
			if err := p.Stop(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNodeFixtureStartupTimeout(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	control, err := filepath.Abs(filepath.Join("..", "desktop", "child-control.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	cliDir := filepath.Join(root, "apps", "cli", "lib")
	_ = os.MkdirAll(cliDir, 0o700)
	_ = os.WriteFile(filepath.Join(cliDir, "bin.js"), []byte(`setInterval(()=>{},1000)`), 0o600)
	store := state.NewStore(filepath.Join(root, "state"))
	p := NewProcess(LaunchConfig{Node: node, ChildControl: control, RuntimeDir: root, HarnessHome: filepath.Join(root, "home"), WorkingDir: root, StartupTimeout: 400 * time.Millisecond, ShutdownTimeout: 400 * time.Millisecond}, store, nil)
	if _, err := p.Start(context.Background()); err == nil {
		t.Fatal("expected startup timeout")
	}
}
