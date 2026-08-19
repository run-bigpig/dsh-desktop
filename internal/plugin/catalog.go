package plugin

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var packageNamePattern = regexp.MustCompile(`^(?:@[a-z0-9._-]+/)?[a-z0-9._-]+$`)

func (m *Manager) Catalog() (Snapshot, error) {
	path := m.catalogPath()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		warning := "插件目录尚未随桌面应用发布。"
		return Snapshot{Plugins: []Plugin{}, CatalogVerified: false, Warning: &warning}, nil
	}
	if err != nil {
		return Snapshot{}, fmt.Errorf("read marketplace catalog: %w", err)
	}
	var document catalogDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return Snapshot{}, fmt.Errorf("decode marketplace catalog: %w", err)
	}
	if document.SchemaVersion != 1 {
		return Snapshot{}, fmt.Errorf("unsupported marketplace catalog schema %d", document.SchemaVersion)
	}
	verified := m.verifyCatalog(data, path)
	var warning *string
	if !verified {
		message := "目录签名未验证；仅允许查看，正式发布前必须配置受信任的 Ed25519 公钥。"
		warning = &message
	}
	m.mu.Lock()
	commit := m.commit
	m.mu.Unlock()
	plugins := make([]Plugin, 0, len(document.Plugins))
	for _, entry := range document.Plugins {
		if err := validateCatalogPlugin(entry); err != nil || allZeroSHA(entry.Release.SHA256) {
			continue
		}
		installed := installedPackageVersion(m.paths.HarnessHome, entry.PackageName)
		plugins = append(plugins, Plugin{
			ID: entry.ID, Name: entry.Name, Description: entry.Description,
			Publisher: entry.Publisher, PackageName: entry.PackageName,
			RepositoryURL: entry.Repository.URL, Version: entry.Release.Version,
			InstalledVersion: installed, Compatible: contains(entry.Compatibility.HarnessCommits, commit),
			Verified: entry.Verified && verified, Permissions: append([]string(nil), entry.Permissions...), License: entry.License,
		})
	}
	return Snapshot{Plugins: plugins, CatalogVerified: verified, GeneratedAt: document.GeneratedAt, Warning: warning}, nil
}

func validateCatalogPlugin(entry catalogPlugin) error {
	if entry.SchemaVersion != 1 || entry.ID == "" || entry.Name == "" || entry.Release.Version == "" {
		return errors.New("catalog entry is incomplete")
	}
	if !packageNamePattern.MatchString(entry.PackageName) {
		return fmt.Errorf("invalid package name %q", entry.PackageName)
	}
	if len(entry.Release.SHA256) != 64 {
		return errors.New("invalid release checksum")
	}
	for _, c := range entry.Release.SHA256 {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return errors.New("invalid release checksum")
		}
	}
	return validateReleaseURL(entry.Release.AssetURL)
}

func (m *Manager) verifyCatalog(data []byte, path string) bool {
	if len(m.trustedCatalogKey) != ed25519.PublicKeySize {
		return false
	}
	signatureText, err := os.ReadFile(filepath.Join(filepath.Dir(path), "catalog.sig"))
	if err != nil {
		return false
	}
	return verifyCatalogSignature(data, signatureText, m.trustedCatalogKey)
}

func verifyCatalogSignature(data, signatureText []byte, publicKey ed25519.PublicKey) bool {
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureText)))
	return err == nil && len(publicKey) == ed25519.PublicKeySize && ed25519.Verify(publicKey, data, signature)
}

func allZeroSHA(value string) bool { return value == strings.Repeat("0", 64) }

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func installedPackageVersion(home, packageName string) *string {
	manifest := filepath.Join(home, "profiles", "web", "node_modules", filepath.FromSlash(packageName), "package.json")
	data, err := os.ReadFile(manifest)
	if err != nil {
		return nil
	}
	var value struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(data, &value) != nil || value.Version == "" {
		return nil
	}
	return &value.Version
}
