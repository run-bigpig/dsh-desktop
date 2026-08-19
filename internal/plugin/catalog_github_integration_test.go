package plugin

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"testing"
	"time"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/buildinfo"
)

func TestGitHubMarketplaceCatalog(t *testing.T) {
	if os.Getenv("DSH_MARKETPLACE_GITHUB_E2E") != "1" {
		t.Skip("set DSH_MARKETPLACE_GITHUB_E2E=1 to verify the production GitHub catalog")
	}
	key, err := base64.StdEncoding.DecodeString(buildinfo.MarketplaceCatalogPublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		t.Fatal("invalid production Marketplace public key")
	}
	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	manager, err := New(Options{
		Paths: paths, CatalogURL: buildinfo.MarketplaceCatalogURL,
		CatalogSignatureURL: buildinfo.MarketplaceCatalogSignatureURL,
		TrustedCatalogKey:   ed25519.PublicKey(key),
	})
	if err != nil {
		t.Fatal(err)
	}
	manager.SetRuntime(t.TempDir(), "47f943859bef60e4160492346772ded9b24f765a")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := manager.RefreshCatalog(ctx); err != nil {
		t.Fatal(err)
	}
	snapshot, err := manager.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.CatalogVerified || snapshot.GeneratedAt == "" {
		t.Fatalf("production catalog was not verified: %+v", snapshot)
	}
}
