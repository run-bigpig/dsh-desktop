param([string]$Version = "0.2.1")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $repoRoot "dist/windows/stage"
$installer = Join-Path $repoRoot "build/windows/installer.nsi"
if (-not (Test-Path (Join-Path $stage "deepseek-harness-desktop.exe"))) {
  throw "Windows stage is missing the desktop executable"
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
  & makensis.exe /INPUTCHARSET UTF8 "/DSTAGE_DIR=$drive" "/DAPP_VERSION=$Version" $installer
  if ($LASTEXITCODE -ne 0) { throw "NSIS packaging failed" }
} finally {
  & subst.exe $drive /D 2>$null
}

$output = Join-Path $repoRoot "dist/windows/DeepSeek-Harness-Desktop-Setup-x64.exe"
$checksum = (Get-FileHash -Algorithm SHA256 $output).Hash.ToLowerInvariant()
Set-Content -Encoding ASCII -NoNewline -Path ($output + ".sha256") -Value ($checksum + "  " + [IO.Path]::GetFileName($output))
