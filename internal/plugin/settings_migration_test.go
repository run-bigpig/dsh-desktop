package plugin

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMigrateDeepSeekDefaultModel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.yaml")
	original := []byte(`# retained comment
locale:
  preference: zh
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high
llm-deepseek:
  baseURL: https://api.deepseek.com
  profile: DEEPSEEK_API_KEY
`)
	if err := os.WriteFile(path, original, 0o640); err != nil {
		t.Fatal(err)
	}

	changed, err := migrateDeepSeekDefaultModel(path)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("DeepSeek default model was not migrated")
	}
	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(updated)
	if strings.Contains(text, "agent-default-model:") || strings.Contains(text, "deepseek-v4-flash") {
		t.Fatalf("obsolete default model was retained:\n%s", text)
	}
	for _, retained := range []string{"# retained comment", "locale:", "llm-deepseek:", "https://api.deepseek.com", "DEEPSEEK_API_KEY"} {
		if !strings.Contains(text, retained) {
			t.Fatalf("migration removed %q:\n%s", retained, text)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o640 {
		t.Fatalf("settings mode = %o, want 640", info.Mode().Perm())
	}

	beforeSecondRun := append([]byte(nil), updated...)
	changed, err = migrateDeepSeekDefaultModel(path)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("migration was not idempotent")
	}
	afterSecondRun, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(afterSecondRun) != string(beforeSecondRun) {
		t.Fatal("idempotent migration rewrote settings")
	}
}

func TestMigrateDeepSeekDefaultModelPreservesOtherProvider(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.yaml")
	original := []byte("agent-default-model:\n  provider: openai\n  model: gpt-5\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err := migrateDeepSeekDefaultModel(path)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("non-DeepSeek default model was migrated")
	}
	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(updated) != string(original) {
		t.Fatal("non-DeepSeek settings were rewritten")
	}
}

func TestMigrateDeepSeekDefaultModelRejectsInvalidYAML(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.yaml")
	original := []byte("agent-default-model: [\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if changed, err := migrateDeepSeekDefaultModel(path); err == nil || changed {
		t.Fatalf("invalid YAML result = %v, %v", changed, err)
	}
	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(updated) != string(original) {
		t.Fatal("invalid YAML was modified")
	}
}

func TestMigrateDeepSeekDefaultModelAllowsMissingFile(t *testing.T) {
	changed, err := migrateDeepSeekDefaultModel(filepath.Join(t.TempDir(), "settings.yaml"))
	if err != nil || changed {
		t.Fatalf("missing settings result = %v, %v", changed, err)
	}
}

func TestInitializeDesktopWelcomeNotice(t *testing.T) {
	for _, original := range []string{"", "# keep\nagent-default-model:\n  provider: openai\n  model: gpt-5\n", "ui-onboarding:\n  other: retained\n"} {
		t.Run(original, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "settings.yaml")
			if original != "" {
				if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := initializeDesktopWelcomeNotice(path); err != nil {
				t.Fatal(err)
			}
			updated, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(updated), "welcomeNoticeVersion: "+desktopWelcomeNoticeVersion) || !strings.Contains(string(updated), original) {
				t.Fatalf("unexpected onboarding settings: %s", updated)
			}
			if err := initializeDesktopWelcomeNotice(path); err != nil {
				t.Fatal(err)
			}
			again, err := os.ReadFile(path)
			if err != nil || string(again) != string(updated) {
				t.Fatalf("onboarding initialization was not idempotent: %v", err)
			}
		})
	}
}

func TestInitializeDesktopWelcomeNoticePreservesExistingChoice(t *testing.T) {
	for _, original := range []string{
		"ui-onboarding:\n  welcomeNoticeVersion: other-version\n",
		"ui-onboarding:\n  welcomeNoticeVersion: ''\n",
	} {
		path := filepath.Join(t.TempDir(), "settings.yaml")
		if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := initializeDesktopWelcomeNotice(path); err != nil {
			t.Fatal(err)
		}
		updated, _ := os.ReadFile(path)
		if string(updated) != original {
			t.Fatal("existing onboarding setting was overwritten")
		}
	}
}

func TestInitializeDesktopWelcomeNoticeRejectsInvalidSettings(t *testing.T) {
	for _, original := range []string{"ui-onboarding: [\n", "- invalid-root\n", "ui-onboarding: invalid\n", "ui-onboarding: {}\nui-onboarding: {}\n"} {
		path := filepath.Join(t.TempDir(), "settings.yaml")
		if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := initializeDesktopWelcomeNotice(path); err == nil {
			t.Fatal("invalid settings were accepted")
		}
		updated, _ := os.ReadFile(path)
		if string(updated) != original {
			t.Fatal("invalid settings were modified")
		}
	}
}

func TestFirstInstallOpenAISettings(t *testing.T) {
	t.Run("new settings seed provider without a secret", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "settings.yaml")
		if err := initializeDesktopWelcomeNotice(path); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"openai:", "baseURL: http://10.225.40.100:3000/v1", "apiKeyEnv: STARWEAVE_OPENAI_API_KEY", desktopWelcomeNoticeVersion} {
			if !strings.Contains(string(data), want) {
				t.Fatalf("missing %q", want)
			}
		}
		if err := initializeDesktopWelcomeNotice(path); err != nil {
			t.Fatal(err)
		}
		again, _ := os.ReadFile(path)
		if string(again) != string(data) {
			t.Fatal("second launch changed settings")
		}
	})
	t.Run("existing global settings preserve providers", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "settings.yaml")
		if err := os.WriteFile(path, []byte("llm-pi-ai:\n  providers:\n    openai:\n      baseURL: https://example.com/v1\n      apiKeyEnv: MY_KEY\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := initializeDesktopWelcomeNotice(path); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), "STARWEAVE_OPENAI_API_KEY") || !strings.Contains(string(data), "https://example.com/v1") {
			t.Fatal("existing provider overwritten")
		}
	})
	t.Run("profile settings prevent first install seeding", func(t *testing.T) {
		home := t.TempDir()
		profile := filepath.Join(home, "profiles", "web")
		if err := os.MkdirAll(profile, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(profile, "settings.yaml"), []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(home, "settings.yaml")
		if err := initializeDesktopWelcomeNotice(path); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), "llm-pi-ai") {
			t.Fatal("profile installation received new defaults")
		}
	})
}
