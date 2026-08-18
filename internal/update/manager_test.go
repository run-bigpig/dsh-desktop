package update

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/deepseek-ai/deepseek-harness-desktop/internal/appconfig"
	"github.com/deepseek-ai/deepseek-harness-desktop/internal/state"
)

type fakeRunner struct {
	calls  []Command
	output []byte
	failAt int
}

func (f *fakeRunner) Run(_ context.Context, c Command) error {
	f.calls = append(f.calls, c)
	if f.failAt == len(f.calls) {
		return errors.New("injected command failure")
	}
	return nil
}
func (f *fakeRunner) Output(_ context.Context, c Command) ([]byte, error) {
	f.calls = append(f.calls, c)
	if f.failAt == len(f.calls) {
		return nil, errors.New("injected output failure")
	}
	return f.output, nil
}

func TestCheckFailureDoesNotModifyActiveRuntime(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	store := state.NewStore(paths.State)
	active := state.ActiveState{Current: state.RuntimeRef{Commit: "1111111111111111111111111111111111111111"}}
	if err := store.SaveActive(active); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{output: []byte("2222222222222222222222222222222222222222\n"), failAt: 2}
	manager := New(paths, appconfig.DefaultConfig(paths), store, Toolchain{Git: "git", Node: "node", PNPM: "pnpm", NodeVersion: "24.8.0", PNPMVersion: "11.7.0"}, runner, io.Discard, nil)
	if _, err := manager.Check(context.Background()); err == nil {
		t.Fatal("expected injected fetch failure")
	}
	if got := store.Snapshot().Active.Current.Commit; got != active.Current.Commit {
		t.Fatalf("active runtime changed to %s", got)
	}
}
