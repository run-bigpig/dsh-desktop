package plugin

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

const (
	agentDefaultModelSettings = "agent-default-model"
	deepSeekOfficialProvider  = "deepseek-official"
)

// migrateDeepSeekDefaultModel removes only the obsolete user-layer DeepSeek
// default. The bundled profile supplies the neutral fallback after this
// override is gone; provider settings and credentials remain untouched.
func migrateDeepSeekDefaultModel(path string) (bool, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("migrate %s: settings document is not a regular file", path)
	}
	original, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}

	var document yaml.Node
	if err := yaml.Unmarshal(original, &document); err != nil {
		return false, fmt.Errorf("parse %s: %w", path, err)
	}
	if len(document.Content) == 0 {
		return false, nil
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode {
		return false, fmt.Errorf("parse %s: settings document root must be a mapping", path)
	}

	sectionIndex := -1
	for index := 0; index+1 < len(root.Content); index += 2 {
		if root.Content[index].Value == agentDefaultModelSettings {
			if sectionIndex >= 0 {
				return false, fmt.Errorf("parse %s: duplicate %s section", path, agentDefaultModelSettings)
			}
			sectionIndex = index
		}
	}
	if sectionIndex < 0 {
		return false, nil
	}
	section := root.Content[sectionIndex+1]
	if section.Kind != yaml.MappingNode || mappingScalar(section, "provider") != deepSeekOfficialProvider {
		return false, nil
	}
	root.Content = append(root.Content[:sectionIndex], root.Content[sectionIndex+2:]...)

	var updated bytes.Buffer
	encoder := yaml.NewEncoder(&updated)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return false, fmt.Errorf("encode %s: %w", path, err)
	}
	if err := encoder.Close(); err != nil {
		return false, fmt.Errorf("encode %s: %w", path, err)
	}
	if err := replaceFile(path, updated.Bytes(), info.Mode().Perm()); err != nil {
		return false, fmt.Errorf("replace %s: %w", path, err)
	}
	return true, nil
}

func (m *Manager) migrateRetiredDeepSeekDefaultModel() error {
	changed, err := migrateDeepSeekDefaultModel(filepath.Join(m.paths.HarnessHome, "settings.yaml"))
	if err != nil {
		return fmt.Errorf("migrate DeepSeek default model: %w", err)
	}
	if changed && m.log != nil {
		_, _ = fmt.Fprintln(m.log, "removed legacy DeepSeek default model selection")
	}
	return nil
}

func mappingScalar(mapping *yaml.Node, key string) string {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key && mapping.Content[index+1].Kind == yaml.ScalarNode {
			return mapping.Content[index+1].Value
		}
	}
	return ""
}

// The pinned Harness reads this version before rendering its welcome notice.
const desktopWelcomeNoticeVersion = "2026-08-13.1"

func initializeDesktopWelcomeNotice(path string) error {
	original, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Seed only a new settings document. Existing installations keep their providers.
	if errors.Is(err, os.ErrNotExist) {
		profileSettings := filepath.Join(filepath.Dir(path), "profiles", "web", "settings.yaml")
		if _, profileErr := os.Stat(profileSettings); errors.Is(profileErr, os.ErrNotExist) {
			original = []byte("llm-pi-ai:\n  providers:\n    openai:\n      apiKeyEnv: STARWEAVE_OPENAI_API_KEY\n      baseURL: http://10.225.40.100:3000/v1\n")
		} else if profileErr != nil {
			return profileErr
		}
	}
	var document yaml.Node
	if err := yaml.Unmarshal(original, &document); err != nil {
		return fmt.Errorf("parse desktop onboarding settings: %w", err)
	}
	if len(document.Content) == 0 {
		document = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode {
		return errors.New("desktop onboarding settings root must be a mapping")
	}
	section := &yaml.Node{Kind: yaml.MappingNode}
	found := false
	for index := 0; index+1 < len(root.Content); index += 2 {
		if root.Content[index].Value == "ui-onboarding" {
			if found {
				return errors.New("duplicate ui-onboarding settings section")
			}
			section, found = root.Content[index+1], true
		}
	}
	if section.Kind != yaml.MappingNode {
		return errors.New("ui-onboarding settings must be a mapping")
	}
	for index := 0; index+1 < len(section.Content); index += 2 {
		if section.Content[index].Value == "welcomeNoticeVersion" {
			return nil
		}
	}
	if !found {
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: "ui-onboarding"}, section)
	}
	section.Content = append(section.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Value: "welcomeNoticeVersion"},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: desktopWelcomeNoticeVersion})
	var updated bytes.Buffer
	encoder := yaml.NewEncoder(&updated)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return err
	}
	if err := encoder.Close(); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	return replaceFile(path, updated.Bytes(), mode)
}
