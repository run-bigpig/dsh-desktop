package desktop

import (
	"context"
	"testing"
	"time"
)

func TestUpdateOperationCanBeCancelled(t *testing.T) {
	service := &RecoveryService{}
	started := make(chan struct{})
	finished := make(chan struct{})
	if err := service.launchUpdate(func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(finished)
		return ctx.Err()
	}); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := service.CancelDesktopUpdate(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("desktop update operation did not stop after cancellation")
	}
}
