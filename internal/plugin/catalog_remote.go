package plugin

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/run-bigpig/dsh-desktop/internal/state"
)

const catalogRefreshInterval = 10 * time.Minute

func (m *Manager) RefreshCatalog(ctx context.Context) error {
	if os.Getenv("DSH_DESKTOP_MARKETPLACE_DIR") != "" || m.catalogURL == "" || m.catalogSignatureURL == "" {
		return nil
	}
	if len(m.trustedCatalogKey) != ed25519.PublicKeySize {
		return errors.New("trusted Marketplace catalog public key is not configured")
	}
	m.catalogMu.Lock()
	defer m.catalogMu.Unlock()
	if !m.lastCatalogRefresh.IsZero() && time.Since(m.lastCatalogRefresh) < catalogRefreshInterval {
		return nil
	}
	catalog, err := m.fetchCatalogFile(ctx, m.catalogURL, 4<<20)
	if err != nil {
		return fmt.Errorf("download Marketplace catalog: %w", err)
	}
	signature, err := m.fetchCatalogFile(ctx, m.catalogSignatureURL, 4<<10)
	if err != nil {
		return fmt.Errorf("download Marketplace catalog signature: %w", err)
	}
	if !verifyCatalogSignature(catalog, signature, m.trustedCatalogKey) {
		return errors.New("downloaded Marketplace catalog signature is invalid")
	}
	if err := validateCatalogDocument(catalog); err != nil {
		return fmt.Errorf("validate downloaded Marketplace catalog: %w", err)
	}
	signaturePath := filepath.Join(m.paths.Marketplace, "catalog.sig")
	catalogPath := filepath.Join(m.paths.Marketplace, "catalog.json")
	if err := state.AtomicWriteFile(signaturePath, signature, 0o600); err != nil {
		return fmt.Errorf("cache Marketplace catalog signature: %w", err)
	}
	if err := state.AtomicWriteFile(catalogPath, catalog, 0o600); err != nil {
		return fmt.Errorf("cache Marketplace catalog: %w", err)
	}
	m.lastCatalogRefresh = time.Now()
	return nil
}

func (m *Manager) fetchCatalogFile(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || !secureCatalogURL(parsed) {
		return nil, errors.New("catalog source must use HTTPS")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github.raw+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "StarWeave-Marketplace/"+desktopPluginVersion)
	response, err := m.catalogClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("response exceeds size limit")
	}
	return data, nil
}

func secureCatalogURL(value *url.URL) bool {
	if value == nil || value.User != nil {
		return false
	}
	if value.Scheme == "https" {
		return true
	}
	host := net.ParseIP(value.Hostname())
	return value.Scheme == "http" && host != nil && host.IsLoopback()
}

func validateCatalogDocument(data []byte) error {
	var document catalogDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return err
	}
	if document.SchemaVersion != 1 {
		return fmt.Errorf("unsupported schema %d", document.SchemaVersion)
	}
	if _, err := time.Parse(time.RFC3339Nano, document.GeneratedAt); err != nil {
		return errors.New("catalog generatedAt is invalid")
	}
	for _, entry := range document.Plugins {
		if err := validateCatalogPlugin(entry); err != nil {
			return fmt.Errorf("plugin %q: %w", entry.ID, err)
		}
	}
	return nil
}
