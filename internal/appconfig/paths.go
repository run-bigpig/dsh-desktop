package appconfig

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const AppDirName = "DeepSeekHarnessDesktop"

type Paths struct {
	Root          string `json:"root"`
	Toolchain     string `json:"toolchain"`
	Repository    string `json:"repository"`
	Versions      string `json:"versions"`
	PNPMStore     string `json:"pnpmStore"`
	HarnessHome   string `json:"harnessHome"`
	Backups       string `json:"backups"`
	Logs          string `json:"logs"`
	Updates       string `json:"updates"`
	Marketplace   string `json:"marketplace"`
	PluginCache   string `json:"pluginCache"`
	PluginTxns    string `json:"pluginTransactions"`
	PluginBackups string `json:"pluginBackups"`
	State         string `json:"state"`
	Locks         string `json:"locks"`
	Workspaces    string `json:"workspaces"`
	ChildControl  string `json:"childControl"`
}

func DefaultRoot() (string, error) {
	if override := os.Getenv("DSH_DESKTOP_DATA_DIR"); override != "" {
		return filepath.Abs(override)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config directory: %w", err)
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(base, "ai.deepseek.harness-desktop"), nil
	}
	return filepath.Join(base, AppDirName), nil
}

func NewPaths(root string) Paths {
	return Paths{
		Root: root, Toolchain: filepath.Join(root, "toolchain"),
		Repository: filepath.Join(root, "repository.git"), Versions: filepath.Join(root, "versions"),
		PNPMStore: filepath.Join(root, "pnpm-store"), HarnessHome: filepath.Join(root, "harness-home"),
		Backups: filepath.Join(root, "backups"), Logs: filepath.Join(root, "logs"), Updates: filepath.Join(root, "updates"),
		Marketplace: filepath.Join(root, "marketplace"), PluginCache: filepath.Join(root, "marketplace", "downloads"),
		PluginTxns: filepath.Join(root, "marketplace", "transactions"), PluginBackups: filepath.Join(root, "marketplace", "backups"),
		State: filepath.Join(root, "state"), Locks: filepath.Join(root, "locks"),
		Workspaces: filepath.Join(root, "workspaces"), ChildControl: filepath.Join(root, "state", "child-control.mjs"),
	}
}

func (p Paths) Ensure() error {
	for _, dir := range []string{p.Root, p.Toolchain, p.Versions, p.PNPMStore, p.HarnessHome, p.Backups, p.Logs, p.Updates, p.Marketplace, p.PluginCache, p.PluginTxns, p.PluginBackups, p.State, p.Locks, p.Workspaces} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create private directory %s: %w", dir, err)
		}
	}
	return nil
}

func (p Paths) Runtime(commit string) (string, error) {
	if !ValidCommit(commit) {
		return "", fmt.Errorf("invalid full commit SHA %q", commit)
	}
	return filepath.Join(p.Versions, commit), nil
}

func ValidCommit(commit string) bool {
	if len(commit) != 40 {
		return false
	}
	for _, c := range commit {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func IsOwnedPath(root, candidate string) bool {
	r, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	c, err := filepath.Abs(candidate)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(r, c)
	return err == nil && rel != "." && rel != ".." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
