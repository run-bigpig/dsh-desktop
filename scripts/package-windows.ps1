param([string]$Version = "0.2.1")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $repoRoot "dist/windows/stage"
$installer = Join-Path $repoRoot "build/windows/installer.nsi"
$seedLock = Get-Content (Join-Path $repoRoot "release/seed.lock.json") -Raw | ConvertFrom-Json
if (-not (Test-Path (Join-Path $stage "dsh-desktop.exe"))) {
  throw "Windows stage is missing the desktop executable"
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
foreach ($directory in "plugin-host","plugin-client","plugin-bundle") {
  $manifest = Join-Path $pluginRoot ($directory + "/package.json")
  if (-not (Test-Path $manifest)) {
    throw "Windows stage is missing the source-built Desktop Plugin package: $manifest"
  }
}

$usedDrives = @([IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.TrimEnd('\') })
$drive = $null
foreach ($letter in [char[]](90..68)) {
  $candidate = "$letter`:"
  if ($candidate -notin $usedDrives) { $drive = $candidate; break }
}
if (-not $drive) { throw "No free drive letter is available for long-path-safe NSIS packaging" }

try {
  & subst.exe $drive $stage
  if ($LASTEXITCODE -ne 0) { throw "Unable to map Windows stage to $drive" }
  Push-Location (Split-Path -Parent $installer)
  try {
    & makensis.exe /INPUTCHARSET UTF8 "/DSTAGE_DIR=$drive" "/DAPP_VERSION=$Version" "/DSEED_COMMIT=$($seedLock.commit)" (Split-Path -Leaf $installer)
    if ($LASTEXITCODE -ne 0) { throw "NSIS packaging failed" }
  } finally {
    Pop-Location
  }
} finally {
  & subst.exe $drive /D 2>$null
}

$output = Join-Path $repoRoot "dist/windows/DSH-DeskTop-Setup-x64.exe"
$checksum = (Get-FileHash -Algorithm SHA256 $output).Hash.ToLowerInvariant()
Set-Content -Encoding ASCII -NoNewline -Path ($output + ".sha256") -Value ($checksum + "  " + [IO.Path]::GetFileName($output))
