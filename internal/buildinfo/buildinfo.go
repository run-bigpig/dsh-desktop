package buildinfo

// These values may be replaced by release builds through -ldflags -X.
var (
	Version                        = "0.2.1"
	ReleaseAPIURL                  = "https://api.github.com/repos/run-bigpig/dsh-desktop/releases/latest"
	MarketplaceCatalogURL          = "https://api.github.com/repos/run-bigpig/dsh-plugin-hub/contents/catalog/catalog.json?ref=main"
	MarketplaceCatalogSignatureURL = "https://api.github.com/repos/run-bigpig/dsh-plugin-hub/contents/catalog/catalog.sig?ref=main"
	MarketplaceCatalogPublicKey    = "ugr1XnWCQuIrDJJ/OQcNncQyUCGWhe/QhDezHfmCLqo="
)

const WindowsX64Asset = "StarWeaveInstaller.exe"
