package appconfig

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const ProductionRemote = "https://github.com/deepseek-ai/deepseek-harness.git"

type Config struct {
	UpdateChannel    string `json:"updateChannel"`
	WorkingDirectory string `json:"workingDirectory"`
	StartupTimeout   int    `json:"startupTimeoutSeconds"`
	ShutdownTimeout  int    `json:"shutdownTimeoutSeconds"`
	DeveloperMode    bool   `json:"developerMode"`
	DeveloperRemote  string `json:"developerRemote,omitempty"`
	DeveloperRef     string `json:"developerRef,omitempty"`
}

func DefaultConfig(paths Paths) Config {
	return Config{UpdateChannel: "stable", WorkingDirectory: paths.Workspaces, StartupTimeout: 45, ShutdownTimeout: 12}
}

func LoadConfig(paths Paths) (Config, error) {
	cfg := DefaultConfig(paths)
	b, err := os.ReadFile(filepath.Join(paths.State, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, err
	}
	if cfg.StartupTimeout < 5 {
		cfg.StartupTimeout = 45
	}
	if cfg.ShutdownTimeout < 2 {
		cfg.ShutdownTimeout = 12
	}
	if !cfg.DeveloperMode {
		cfg.DeveloperRemote, cfg.DeveloperRef = "", ""
	}
	return cfg, nil
}

func (c Config) RemoteAndRef() (string, string) {
	if c.DeveloperMode && c.DeveloperRemote != "" && c.DeveloperRef != "" {
		return c.DeveloperRemote, c.DeveloperRef
	}
	return ProductionRemote, "refs/heads/master"
}

func (c Config) StartDuration() time.Duration { return time.Duration(c.StartupTimeout) * time.Second }
func (c Config) StopDuration() time.Duration  { return time.Duration(c.ShutdownTimeout) * time.Second }
