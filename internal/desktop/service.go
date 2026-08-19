package desktop

import (
	"context"
	"fmt"
	"sync"

	"github.com/run-bigpig/dsh-desktop/internal/backup"
	"github.com/run-bigpig/dsh-desktop/internal/state"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type RecoveryService struct {
	coordinator *Coordinator
	app         *application.App
	mu          sync.Mutex
	operation   bool
	window      *application.WebviewWindow
}

func NewRecoveryService(c *Coordinator, app *application.App) *RecoveryService {
	return &RecoveryService{coordinator: c, app: app}
}
func (s *RecoveryService) SetWindow(window *application.WebviewWindow) {
	s.mu.Lock()
	s.window = window
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
		window := s.window
		s.mu.Unlock()
		if window != nil {
			window.Show()
			window.Restore()
			window.Focus()
		}
		s.showError("无法打开 dsh 终端", err.Error())
		return err
	}
	return nil
}
func (s *RecoveryService) CheckForUpdates() error {
	return s.launch(func() error {
		update, err := s.coordinator.CheckDesktopUpdate(context.Background())
		if err != nil {
			s.showError("无法检查更新", err.Error())
			return nil
		}
		if update == nil {
			s.showInfo("已是最新版本", "当前 DeepSeek Harness Desktop 已是最新版本。")
			return nil
		}
		if !s.showAvailableUpdate(update) {
			return nil
		}
		if err := s.coordinator.InstallDesktopUpdate(context.Background()); err != nil {
			s.showError("更新安装失败", err.Error())
			return nil
		}
		s.app.Quit()
		return nil
	})
}
func (s *RecoveryService) InstallDesktopUpdate() error {
	return s.launch(func() error {
		if err := s.coordinator.InstallDesktopUpdate(context.Background()); err != nil {
			s.showError("更新安装失败", err.Error())
			return nil
		}
		s.app.Quit()
		return nil
	})
}
func (s *RecoveryService) NotifyAvailableUpdate() {
	if update := s.coordinator.Store().Snapshot().AvailableUpdate; update != nil {
		if s.showAvailableUpdate(update) {
			_ = s.InstallDesktopUpdate()
		}
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
func (s *RecoveryService) showAvailableUpdate(update *state.DesktopUpdate) bool {
	install := false
	dialog := s.app.Dialog.Question().SetTitle("发现桌面更新").SetMessage(
		"DeepSeek Harness Desktop " + update.Version + " 已发布。\n\n是否下载完整安装包并自动升级？Harness 私有数据会保留。",
	)
	s.attach(dialog)
	dialog.AddButton("稍后").SetAsCancel()
	dialog.AddButton("下载并安装").SetAsDefault().OnClick(func() { install = true })
	dialog.Show()
	return install
}
func (s *RecoveryService) showInfo(title, message string) {
	dialog := s.app.Dialog.Info().SetTitle(title).SetMessage(message)
	s.attach(dialog)
	dialog.AddButton("确定").SetAsDefault()
	dialog.Show()
}
func (s *RecoveryService) showError(title, message string) {
	dialog := s.app.Dialog.Error().SetTitle(title).SetMessage(message)
	s.attach(dialog)
	dialog.AddButton("确定").SetAsDefault()
	dialog.Show()
}
func (s *RecoveryService) attach(dialog *application.MessageDialog) {
	s.mu.Lock()
	window := s.window
	s.mu.Unlock()
	if window != nil {
		dialog.AttachToWindow(window)
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
