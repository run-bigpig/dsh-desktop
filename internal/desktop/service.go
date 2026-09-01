package desktop

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/run-bigpig/dsh-desktop/internal/backup"
	"github.com/run-bigpig/dsh-desktop/internal/state"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type RecoveryService struct {
	coordinator  *Coordinator
	app          *application.App
	mu           sync.Mutex
	operation    bool
	dialogWindow *application.WebviewWindow
	updateWindow *application.WebviewWindow
	updateCancel context.CancelFunc
}

func NewRecoveryService(c *Coordinator, app *application.App) *RecoveryService {
	return &RecoveryService{coordinator: c, app: app}
}
func (s *RecoveryService) SetWindow(window *application.WebviewWindow) {
	s.mu.Lock()
	s.dialogWindow = window
	s.mu.Unlock()
}
func (s *RecoveryService) SetUpdateWindow(window *application.WebviewWindow) {
	s.mu.Lock()
	s.updateWindow = window
	s.mu.Unlock()
}
func (s *RecoveryService) GetState() state.Snapshot            { return s.coordinator.Store().Snapshot() }
func (s *RecoveryService) ListBackups() ([]backup.Info, error) { return s.coordinator.ListBackups() }
func (s *RecoveryService) RetryStart() error {
	return s.launch(func() error { return s.coordinator.Restart(context.Background()) })
}
func (s *RecoveryService) RestartHarness() error { return s.RetryStart() }
func (s *RecoveryService) OpenDSHTerminal() error {
	if err := s.coordinator.OpenDSHTerminal(); err != nil {
		s.mu.Lock()
		window := s.dialogWindow
		s.mu.Unlock()
		if window != nil {
			window.Show()
			window.Restore()
			window.Focus()
		}
		s.showError("无法打开终端", err.Error())
		return err
	}
	return nil
}
func (s *RecoveryService) CheckForUpdates() error {
	s.showUpdateWindow()
	return s.launchUpdate(func(ctx context.Context) error {
		_, err := s.coordinator.CheckDesktopUpdate(ctx)
		return err
	})
}
func (s *RecoveryService) InstallDesktopUpdate() error {
	s.showUpdateWindow()
	return s.launchUpdate(func(ctx context.Context) error {
		if err := s.coordinator.InstallDesktopUpdate(ctx); err != nil {
			return err
		}
		s.app.Quit()
		return nil
	})
}
func (s *RecoveryService) CancelDesktopUpdate() error {
	s.mu.Lock()
	cancel := s.updateCancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}
func (s *RecoveryService) CloseUpdateWindow() error {
	_ = s.CancelDesktopUpdate()
	s.mu.Lock()
	window := s.updateWindow
	s.mu.Unlock()
	if window != nil {
		window.Hide()
	}
	return nil
}
func (s *RecoveryService) NotifyAvailableUpdate() {
	if update := s.coordinator.Store().Snapshot().AvailableUpdate; update != nil {
		s.showUpdateWindow()
	}
}
func (s *RecoveryService) Rollback(confirmed bool) error {
	return s.launch(func() error { return s.coordinator.Rollback(context.Background(), confirmed) })
}
func (s *RecoveryService) OpenLogs() error {
	return s.app.Env.OpenFileManager(s.coordinator.Paths().Logs, false)
}
func (s *RecoveryService) OpenDataDirectory() error {
	return s.app.Env.OpenFileManager(s.coordinator.Paths().Root, false)
}
func (s *RecoveryService) showError(title, message string) {
	dialog := s.app.Dialog.Error().SetTitle(title).SetMessage(message)
	s.attach(dialog)
	dialog.AddButton("确定").SetAsDefault()
	dialog.Show()
}
func (s *RecoveryService) attach(dialog *application.MessageDialog) {
	s.mu.Lock()
	window := s.dialogWindow
	s.mu.Unlock()
	if window != nil {
		dialog.AttachToWindow(window)
	}
}
func (s *RecoveryService) showUpdateWindow() {
	s.mu.Lock()
	window := s.updateWindow
	s.mu.Unlock()
	if window != nil {
		window.Show()
		window.Restore()
		window.Focus()
	}
}
func (s *RecoveryService) launch(operation func() error) error {
	s.mu.Lock()
	if s.operation {
		s.mu.Unlock()
		return fmt.Errorf("another desktop operation is already running")
	}
	s.operation = true
	s.mu.Unlock()
	go func() {
		defer func() { s.mu.Lock(); s.operation = false; s.mu.Unlock() }()
		if err := operation(); err != nil {
			s.coordinator.Store().SetRuntimeInfo(state.Failed, err.Error(), "")
			s.coordinator.showRecovery()
		}
	}()
	return nil
}

func (s *RecoveryService) launchUpdate(operation func(context.Context) error) error {
	s.mu.Lock()
	if s.operation {
		s.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.operation = true
	s.updateCancel = cancel
	s.mu.Unlock()
	go func() {
		defer func() {
			cancel()
			s.mu.Lock()
			s.operation = false
			s.updateCancel = nil
			s.mu.Unlock()
		}()
		if err := operation(ctx); err != nil && !errors.Is(err, context.Canceled) {
			return
		}
	}()
	return nil
}
