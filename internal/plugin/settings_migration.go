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
