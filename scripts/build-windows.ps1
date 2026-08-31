param(
  [string]$Version = "0.2.2",
  [string]$ReleaseAPI = "https://api.github.com/repos/run-bigpig/dsh-desktop/releases/latest"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "windows-build-common.ps1")
$buildLock = Enter-WindowsBuildLock $repoRoot

$fingerprint = Get-WindowsDesktopFingerprint -RepoRoot $repoRoot -Version $Version -ReleaseAPI $ReleaseAPI
$stage = Join-Path $repoRoot "dist/windows/stage"
$outputRoot = Join-Path $repoRoot "dist/windows/desktop-build"
$temporaryExe = Join-Path $outputRoot "StarWeave.exe"
$stageExe = Join-Path $stage "StarWeave.exe"
$legacyStageExe = Join-Path $stage "dsh-desktop.exe"
$manifestPath = Join-Path $stage "desktop-build.json"
New-Item -ItemType Directory -Force $stage,$outputRoot | Out-Null
Remove-Item -LiteralPath $temporaryExe -Force -ErrorAction SilentlyContinue

Push-Location $repoRoot
try {
  & wails3 generate syso -arch amd64 -icon build/windows/icon.ico -manifest build/windows/app.manifest -info build/windows/info.json -out cmd/dsh-desktop/wails_windows_amd64.syso
  if ($LASTEXITCODE -ne 0) { throw "Wails Windows metadata generation failed" }
  $ldflags = "-s -w -H windowsgui -X github.com/run-bigpig/dsh-desktop/internal/buildinfo.Version=$Version -X github.com/run-bigpig/dsh-desktop/internal/buildinfo.ReleaseAPIURL=$ReleaseAPI"
  $env:GOOS = "windows"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "0"
  & go build -tags production -trimpath ("-ldflags=" + $ldflags) -o $temporaryExe ./cmd/dsh-desktop
  if ($LASTEXITCODE -ne 0) { throw "Windows desktop executable build failed" }
} finally {
  Pop-Location
}

$finalFingerprint = Get-WindowsDesktopFingerprint -RepoRoot $repoRoot -Version $Version -ReleaseAPI $ReleaseAPI
if ($finalFingerprint -ne $fingerprint) {
  Remove-Item -LiteralPath $temporaryExe -Force -ErrorAction SilentlyContinue
  throw "Desktop sources changed during the Windows build; retry from a stable worktree"
}
$exeHash = Get-SHA256File $temporaryExe
Move-Item -LiteralPath $temporaryExe -Destination $stageExe -Force
Remove-Item -LiteralPath $legacyStageExe -Force -ErrorAction SilentlyContinue
Write-JsonAtomic -Path $manifestPath -Value ([ordered]@{
  schemaVersion = 1
  fingerprint = $fingerprint
  version = $Version
  releaseAPI = $ReleaseAPI
  executable = "StarWeave.exe"
  executableSHA256 = $exeHash
  createdAtUTC = [DateTime]::UtcNow.ToString("o")
})
$buildLock.Dispose()
Write-Host "Production Windows desktop staged with fingerprint $fingerprint"
