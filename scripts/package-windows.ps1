param(
  [string]$Version = "0.2.11",
  [string]$ReleaseAPI = "https://api.github.com/repos/run-bigpig/dsh-desktop/releases/latest"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "windows-build-common.ps1")
$buildLock = Enter-WindowsBuildLock $repoRoot
$stage = Join-Path $repoRoot "dist/windows/stage"
$installer = Join-Path $repoRoot "build/windows/installer.nsi"
$seedLock = Get-Content (Join-Path $repoRoot "release/seed.lock.json") -Raw | ConvertFrom-Json
$desktopManifestPath = Join-Path $stage "desktop-build.json"
$seedManifestPath = Join-Path $stage "resources/seed/build-manifest.json"
$desktopExe = Join-Path $stage "StarWeave.exe"
$output = Join-Path $repoRoot "dist/windows/StarWeaveInstaller.exe"
$checksumPath = $output + ".sha256"
$installerManifestPath = Join-Path $repoRoot "dist/windows/installer-build.json"
if (-not (Test-Path $desktopExe)) {
  throw "Windows stage is missing the desktop executable"
}
if (Test-Path (Join-Path $stage "dsh-desktop.exe")) {
  throw "Windows stage still contains the legacy desktop executable; run task build:windows"
}
if (-not (Test-Path $desktopManifestPath)) {
  throw "Windows stage is missing its desktop build manifest; run task build:windows"
}
if (-not (Test-Path $seedManifestPath)) {
  throw "Windows stage is missing its verified seed manifest; run task seed:windows"
}
$desktopManifest = Get-Content $desktopManifestPath -Raw | ConvertFrom-Json
$seedManifest = Get-Content $seedManifestPath -Raw | ConvertFrom-Json
$desktopFingerprint = Get-WindowsDesktopFingerprint -RepoRoot $repoRoot -Version $Version -ReleaseAPI $ReleaseAPI
$sourceSeedFingerprint = Get-WindowsSeedFingerprint $repoRoot
if (
  $seedManifest.schemaVersion -ne 2 -or
  -not ($seedManifest.PSObject.Properties.Name -contains "sourceFingerprint") -or
  -not ($seedManifest.PSObject.Properties.Name -contains "designRelease") -or
  $null -eq $seedManifest.designRelease -or
  -not ($seedManifest.designRelease.PSObject.Properties.Name -contains "tag") -or
  -not ($seedManifest.designRelease.PSObject.Properties.Name -contains "sha256") -or
  -not ($seedManifest.designRelease.PSObject.Properties.Name -contains "commit") -or
  $seedManifest.designRelease.tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$' -or
  $seedManifest.designRelease.sha256 -notmatch '^[0-9a-f]{64}$' -or
  $seedManifest.designRelease.commit -notmatch '^[0-9a-f]{40}$'
) {
  throw "Windows seed stage predates the StarWeave UI release contract; run task seed:windows"
}
$seedFingerprint = Get-SHA256Text ((@(
  "source=$sourceSeedFingerprint",
  "designTag=$($seedManifest.designRelease.tag)",
  "designSHA256=$($seedManifest.designRelease.sha256)"
) -join "`n"))
if ($desktopManifest.fingerprint -ne $desktopFingerprint -or $desktopManifest.version -ne $Version -or $desktopManifest.releaseAPI -ne $ReleaseAPI) {
  throw "Windows desktop stage is stale; run task build:windows"
}
if (
  $seedManifest.fingerprint -ne $seedFingerprint -or
  $seedManifest.sourceFingerprint -ne $sourceSeedFingerprint -or
  $seedManifest.commit -ne $seedLock.commit
) {
  throw "Windows seed stage is stale; run task seed:windows"
}
if (Test-Path -LiteralPath (Join-Path $stage "resources/openpencil")) {
  throw "Windows stage still contains the removed OpenPencil Companion payload; run task seed:windows"
}
$desktopHash = Get-SHA256File $desktopExe
if ($desktopManifest.executableSHA256 -ne $desktopHash) {
  throw "Windows desktop executable does not match its build manifest"
}
if (-not (Test-Path (Join-Path $stage "resources/toolchain/node/node.exe"))) {
  throw "Windows stage is missing embedded Node"
}
foreach ($requiredToolchainFile in "node/LICENSE","node/node.exe","pnpm/pnpm.exe","pnpm/dist/pnpm.mjs","pnpm/dist/pnpmrc","pnpm/dist/worker.js") {
  if (-not (Test-Path (Join-Path $stage ("resources/toolchain/" + $requiredToolchainFile)))) {
    throw "Windows stage is missing runtime toolchain file: $requiredToolchainFile"
  }
}
$seedRoot = Join-Path $stage ("resources/seed/source/" + $seedLock.commit)
foreach ($required in "package.json","pnpm-lock.yaml","pnpm-workspace.yaml",$seedLock.cliEntry) {
  if (-not (Test-Path (Join-Path $seedRoot $required))) {
    throw "Windows stage is missing the installable Harness seed file: $required"
  }
}
$bundledNodeModules = Get-ChildItem $seedRoot -Directory -Recurse -Filter node_modules | Select-Object -First 1
if ($bundledNodeModules) {
  throw "Windows installer must not bundle seed node_modules: $($bundledNodeModules.FullName)"
}
$packagedRuntime = Join-Path $stage ("resources/seed/runtime/" + $seedLock.commit)
if (Test-Path $packagedRuntime) {
  throw "Windows installer must generate the Harness runtime during installation: $packagedRuntime"
}
$pluginRoot = Join-Path $stage "resources/plugin"
$pluginPackages = @(
  @{ directory = "plugin-host"; version = $seedManifest.pluginVersion },
  @{ directory = "plugin-client"; version = $seedManifest.pluginVersion },
  @{ directory = "plugin-bundle"; version = $seedManifest.pluginVersion }
)
foreach ($package in $pluginPackages) {
  $manifest = Join-Path $pluginRoot ($package.directory + "/package.json")
  if (-not (Test-Path $manifest)) {
    throw "Windows stage is missing the source-built Desktop Plugin package: $manifest"
  }
  $pluginManifest = Get-Content $manifest -Raw | ConvertFrom-Json
  if ($pluginManifest.version -ne $package.version) {
    throw "Windows stage contains a stale built-in plugin package: $manifest"
  }
}
foreach ($requiredDesignFile in @(
  "plugin-host/lib/design.js",
  "plugin-host/web/starweave-ui/index.html",
  "plugin-host/web/starweave-ui/canvaskit.wasm",
  "plugin-host/web/starweave-ui/starweave-ui-build.json",
  "plugin-bundle/LICENSES/open-pencil-MIT.txt"
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot $requiredDesignFile))) {
    throw "Windows stage is missing StarWeave Design resource: $requiredDesignFile; run task seed:windows"
  }
}
$designBuildManifest = Get-Content (Join-Path $pluginRoot "plugin-host/web/starweave-ui/starweave-ui-build.json") -Raw | ConvertFrom-Json
if (
  $designBuildManifest.schemaVersion -ne 1 -or
  $designBuildManifest.tag -cne $seedManifest.designRelease.tag -or
  $designBuildManifest.commit -cne $seedManifest.designRelease.commit -or
  ("v" + [string]$designBuildManifest.version) -cne $seedManifest.designRelease.tag
) {
  throw "Windows stage contains a StarWeave UI release manifest mismatch; run task seed:windows"
}

$compilerVersion = (& makensis.exe /VERSION).Trim()
if ($LASTEXITCODE -ne 0 -or -not $compilerVersion) { throw "Unable to determine the NSIS compiler version" }
$installerSourceFingerprint = Get-SourceFingerprint -RepoRoot $repoRoot -Paths @(
  "build/windows/installer.nsi",
  "build/windows/icon.ico",
  "build/windows/install-runtime.ps1",
  "build/windows/cleanup-resources.ps1",
  "scripts/materialize-workspace-runtime.mjs"
)
$installerFingerprint = Get-SHA256Text ((@(
  "installerSource=$installerSourceFingerprint",
  "desktopFingerprint=$desktopFingerprint",
  "desktopSHA256=$desktopHash",
  "seedFingerprint=$seedFingerprint",
  "seedCommit=$($seedLock.commit)",
  "version=$Version",
  "compiler=$compilerVersion"
) -join "`n"))
if ((Test-Path -LiteralPath $installerManifestPath) -and (Test-Path -LiteralPath $output) -and (Test-Path -LiteralPath $checksumPath)) {
  try {
    $installerManifest = Get-Content $installerManifestPath -Raw | ConvertFrom-Json
    $outputHash = Get-SHA256File $output
    $expectedChecksum = $outputHash + "  " + [IO.Path]::GetFileName($output)
    $checksumMatches = (Get-Content $checksumPath -Raw).Trim() -eq $expectedChecksum
    if ($installerManifest.fingerprint -eq $installerFingerprint -and $installerManifest.installerSHA256 -eq $outputHash -and $checksumMatches) {
      $buildLock.Dispose()
      Write-Host "Verified Windows installer is current; skipping NSIS compression ($installerFingerprint)"
      exit 0
    }
  } catch {
    Write-Warning "Existing Windows installer cache is invalid; rebuilding it"
  }
}

$usedDrives = @([IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.TrimEnd('\') })
$drive = $null
foreach ($letter in [char[]](90..68)) {
  $candidate = "$letter`:"
  if ($candidate -notin $usedDrives) { $drive = $candidate; break }
}
if (-not $drive) { throw "No free drive letter is available for long-path-safe NSIS packaging" }
$temporaryOutput = Join-Path $repoRoot ("dist/windows/StarWeaveInstaller.tmp-" + [Guid]::NewGuid().ToString("N") + ".exe")

try {
  & subst.exe $drive $stage
  if ($LASTEXITCODE -ne 0) { throw "Unable to map Windows stage to $drive" }
  Push-Location (Split-Path -Parent $installer)
  try {
    & makensis.exe /INPUTCHARSET UTF8 "/DSTAGE_DIR=$drive" "/DAPP_VERSION=$Version" "/DSEED_COMMIT=$($seedLock.commit)" "/DINSTALLER_OUTPUT=$temporaryOutput" (Split-Path -Leaf $installer)
    if ($LASTEXITCODE -ne 0) { throw "NSIS packaging failed" }
  } finally {
    Pop-Location
  }
} catch {
  Remove-Item -LiteralPath $temporaryOutput -Force -ErrorAction SilentlyContinue
  throw
} finally {
  & subst.exe $drive /D 2>$null
}

if (-not (Test-Path -LiteralPath $temporaryOutput)) { throw "NSIS did not create the temporary Windows installer" }
Move-Item -LiteralPath $temporaryOutput -Destination $output -Force
$checksum = Get-SHA256File $output
Set-Content -Encoding ASCII -NoNewline -Path $checksumPath -Value ($checksum + "  " + [IO.Path]::GetFileName($output))
Write-JsonAtomic -Path $installerManifestPath -Value ([ordered]@{
  schemaVersion = 1
  fingerprint = $installerFingerprint
  version = $Version
  seedCommit = $seedLock.commit
  compiler = $compilerVersion
  installerSHA256 = $checksum
  createdAtUTC = [DateTime]::UtcNow.ToString("o")
})
$buildLock.Dispose()
