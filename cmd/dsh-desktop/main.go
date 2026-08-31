package main

import (
	"context"
	"log"
	"log/slog"
	"os"
	"runtime"
	"sync/atomic"
	"time"

	desktopassets "github.com/run-bigpig/dsh-desktop"
	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/buildinfo"
	"github.com/run-bigpig/dsh-desktop/internal/desktop"
	appLog "github.com/run-bigpig/dsh-desktop/internal/logging"
	"github.com/run-bigpig/dsh-desktop/internal/selfupdate"
	"github.com/run-bigpig/dsh-desktop/internal/state"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/icons"
)

func main() {
	if handled, err := selfupdate.HandleHelperMode(os.Args[1:]); handled {
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if _, err := appconfig.MigrateLegacyRoot(); err != nil {
		log.Fatal(err)
	}
	root, err := appconfig.DefaultRoot()
	if err != nil {
		log.Fatal(err)
	}
	paths := appconfig.NewPaths(root)
	if err := paths.Ensure(); err != nil {
		log.Fatal(err)
	}
	writer, err := appLog.NewRotatingWriter(paths.Logs+string(os.PathSeparator)+"desktop.log", 5<<20, 5)
	if err != nil {
		log.Fatal(err)
	}
	defer writer.Close()
	logger := slog.New(slog.NewTextHandler(writer, &slog.HandlerOptions{Level: slog.LevelInfo}))
	logger.Info("starting desktop application", "version", buildinfo.Version)
	coordinator, err := desktop.NewCoordinator(root, writer)
	if err != nil {
		log.Fatal(err)
	}
	var mainWindow *application.WebviewWindow
	var splashWindow *application.WebviewWindow
	var service *desktop.RecoveryService
	var quitting atomic.Bool
	var awaitingHarnessNavigation atomic.Bool
	var transitionID atomic.Uint64
	var mainVisible atomic.Bool
	showSplash := func() {
		if splashWindow == nil {
			return
		}
		transitionID.Add(1)
		mainVisible.Store(false)
		if mainWindow != nil {
			splashWindow.SetBounds(mainWindow.Bounds())
		}
		if service != nil {
			service.SetWindow(splashWindow)
		}
		splashWindow.ExecJS("window.activateSplash && window.activateSplash()")
		splashWindow.SetAlwaysOnTop(true)
		splashWindow.Show()
		splashWindow.Restore()
		splashWindow.Focus()
		if mainWindow != nil {
			mainWindow.Hide()
		}
		splashWindow.SetAlwaysOnTop(false)
	}
	showMain := func() {
		if mainWindow == nil {
			return
		}
		if mainVisible.Load() {
			mainWindow.Show()
			mainWindow.Restore()
			mainWindow.Focus()
			return
		}
		currentTransition := transitionID.Add(1)
		if splashWindow != nil {
			mainWindow.SetBounds(splashWindow.Bounds())
			splashWindow.SetAlwaysOnTop(true)
			splashWindow.ExecJS("window.finishSplash && window.finishSplash()")
		}
		if service != nil {
			service.SetWindow(mainWindow)
		}
		mainWindow.Show()
		time.AfterFunc(140*time.Millisecond, func() {
			if transitionID.Load() != currentTransition {
				return
			}
			mainVisible.Store(true)
			if splashWindow != nil {
				splashWindow.ExecJS("window.parkSplash && window.parkSplash()")
				splashWindow.Hide()
				splashWindow.SetAlwaysOnTop(false)
			}
			mainWindow.Restore()
			mainWindow.Focus()
		})
	}
	navigateHarness := func(url string) {
		if mainWindow == nil {
			return
		}
		logger.Info("navigating webview to Harness", "url", url)
		awaitingHarnessNavigation.Store(true)
		mainWindow.SetURL(url)
	}
	openHarness := func() {
		snapshot := coordinator.Store().Snapshot()
		if snapshot.Phase == state.Ready && snapshot.HarnessURL != "" {
			if awaitingHarnessNavigation.Load() {
				showSplash()
			} else {
				showMain()
			}
			return
		}
		showSplash()
	}
	var app *application.App
	app = application.New(application.Options{Name: "StarWeave", Description: "Independent desktop runtime for the official DeepSeek Harness web UI", Icon: desktopassets.AppIcon, Logger: logger,
		Assets:  application.AssetOptions{Handler: application.BundledAssetFileServer(desktopassets.Frontend)},
		Windows: application.WindowsOptions{DisableQuitOnLastWindowClosed: true, WebviewUserDataPath: paths.State + string(os.PathSeparator) + "webview2"}, Linux: application.LinuxOptions{DisableQuitOnLastWindowClosed: true, ProgramName: "starweave"},
		SingleInstance: &application.SingleInstanceOptions{UniqueID: "ai.deepseek.harness-desktop", OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
			for _, arg := range data.Args {
				if arg == "--quit-for-update" {
					logger.Info("installer requested application shutdown")
					quitting.Store(true)
					app.Quit()
					return
				}
			}
			openHarness()
		}},
		ShouldQuit: func() bool { return true }, OnShutdown: func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_ = coordinator.Close(ctx)
		},
	})
	service = desktop.NewRecoveryService(coordinator, app)
	app.RegisterService(application.NewService(service))
	windowHeight, minWindowHeight := 840, 620
	if runtime.GOOS == "windows" {
		const desktopChromeHeight = 38
		windowHeight += desktopChromeHeight
		minWindowHeight += desktopChromeHeight
	}
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{Name: "main", Title: "StarWeave", Width: 1280, Height: windowHeight, MinWidth: 760, MinHeight: minWindowHeight, InitialPosition: application.WindowCentered, Hidden: true, Frameless: runtime.GOOS == "windows", BackgroundColour: application.RGBA{Red: 13, Green: 16, Blue: 23, Alpha: 255}, URL: "/", Windows: application.WindowsWindow{NonClientRegionSupport: true}})
	splashWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{Name: "splash", Title: "StarWeave", Width: 1280, Height: windowHeight, MinWidth: 760, MinHeight: minWindowHeight, InitialPosition: application.WindowCentered, Frameless: true, BackgroundColour: application.RGBA{Red: 13, Green: 16, Blue: 23, Alpha: 255}, URL: "/"})
	coordinator.SetWindow(mainWindow)
	service.SetWindow(splashWindow)
	finishHarnessNavigation := func(*application.WindowEvent) {
		if awaitingHarnessNavigation.CompareAndSwap(true, false) {
			logger.Info("Harness navigation completed; swapping desktop windows")
			showMain()
		}
	}
	mainWindow.RegisterHook(events.Windows.WebViewNavigationCompleted, finishHarnessNavigation)
	mainWindow.RegisterHook(events.Mac.WebViewDidFinishNavigation, finishHarnessNavigation)
	registerClosingHook := func(window *application.WebviewWindow) {
		window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
			if !quitting.Load() {
				window.Hide()
				e.Cancel()
			}
		})
	}
	registerClosingHook(mainWindow)
	registerClosingHook(splashWindow)
	coordinator.SetNavigation(func(url string) {
		logger.Info("Harness ready; holding splash before handoff", "delay", time.Second)
		time.Sleep(time.Second)
		navigateHarness(url)
	}, func() {
		logger.Info("showing persistent splash window")
		awaitingHarnessNavigation.Store(false)
		showSplash()
	})
	tray := app.SystemTray.New()
	tray.SetTooltip("StarWeave")
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(icons.SystrayMacTemplate)
	} else {
		tray.SetIcon(desktopassets.AppIcon)
		tray.SetDarkModeIcon(desktopassets.AppIcon)
	}
	menu := app.NewMenu()
	menu.Add("显示").OnClick(func(*application.Context) { openHarness() })
	menu.Add("终端").OnClick(func(*application.Context) { _ = service.OpenDSHTerminal() })
	menu.Add("更新").OnClick(func(*application.Context) {
		openHarness()
		_ = service.CheckForUpdates()
	})
	menu.Add("重启").OnClick(func(*application.Context) { _ = service.RestartHarness() })
	menu.Add("日志").OnClick(func(*application.Context) { _ = service.OpenLogs() })
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(*application.Context) { quitting.Store(true); app.Quit() })
	tray.SetMenu(menu)
	go func() {
		if err := coordinator.EnsurePrivateToolchain(); err != nil {
			logger.Warn("unable to cache embedded toolchain", "error", err)
		}
		if err := coordinator.Start(context.Background()); err != nil {
			logger.Error("Harness startup failed", "error", err)
			return
		}
	}()
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
