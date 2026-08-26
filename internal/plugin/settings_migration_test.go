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
