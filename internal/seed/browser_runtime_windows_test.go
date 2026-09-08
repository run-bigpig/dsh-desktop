package seed

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestBrowserRuntimePreparationWithoutGetFileHash(t *testing.T) {
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	files := map[string]string{
		"build/native/x64/WebView2Loader.dll": "fixture-loader",
		"LICENSE.txt":                         "fixture-license",
	}
	for name, content := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, valid := range []bool{true, false} {
		t.Run(fmt.Sprintf("valid-checksum=%t", valid), func(t *testing.T) {
			root := t.TempDir()
			write := func(name string, data []byte) {
				t.Helper()
				path := filepath.Join(root, name)
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range []string{"prepare-browser-runtime.ps1", "windows-build-common.ps1"} {
				data, err := os.ReadFile(filepath.Join("..", "..", "scripts", name))
				if err != nil {
					t.Fatal(err)
				}
				write(filepath.Join("scripts", name), data)
			}
			hash := fmt.Sprintf("%x", sha256.Sum256(archive.Bytes()))
			if !valid {
				hash = strings.Repeat("0", 64)
			}
			lock, err := json.Marshal(map[string]string{"version": "fixture", "sha256": hash})
			if err != nil {
				t.Fatal(err)
			}
			write("release/browser.lock.json", lock)
			write("dist/windows/browser-runtime/webview2-fixture.zip", archive.Bytes())
			// Reproduce a host where PowerShell cannot supply Get-FileHash.
			write("probe.ps1", []byte("$ErrorActionPreference = 'Stop'\nfunction Get-FileHash { throw 'Get-FileHash is unavailable' }\n& (Join-Path $PSScriptRoot 'scripts/prepare-browser-runtime.ps1')\n"))
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(root, "probe.ps1"))
			command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}
			output, err := command.CombinedOutput()
			if !valid {
				if err == nil || !strings.Contains(string(output), "Packaged WebView2 SDK checksum mismatch") {
					t.Fatalf("invalid archive was not rejected by checksum validation: %v\n%s", err, output)
				}
				if _, err := os.Stat(filepath.Join(root, "dist/windows/stage/resources/browser")); !os.IsNotExist(err) {
					t.Fatal("invalid archive created staged browser files")
				}
				return
			}
			if err != nil {
				t.Fatalf("browser preparation failed: %v\n%s", err, output)
			}
			for name, want := range files {
				data, err := os.ReadFile(filepath.Join(root, "dist/windows/stage/resources/browser", filepath.Base(name)))
				if err != nil || string(data) != want {
					t.Fatalf("unexpected staged %s: %q, %v", name, data, err)
				}
			}
		})
	}
}
