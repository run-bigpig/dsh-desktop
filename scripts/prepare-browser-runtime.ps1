param([string]$Stage = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows-build-common.ps1')
if (-not $Stage) { $Stage = Join-Path $repoRoot 'dist/windows/stage' }
$lock = Get-Content (Join-Path $repoRoot 'release/browser.lock.json') -Raw | ConvertFrom-Json
$cache = Join-Path $repoRoot 'dist/windows/browser-runtime'
New-Item -ItemType Directory -Force $cache | Out-Null
$archive = Join-Path $cache ('webview2-' + $lock.version + '.zip')
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -UseBasicParsing $lock.url -OutFile $archive }
if ((Get-SHA256File $archive) -ne $lock.sha256) { throw 'Packaged WebView2 SDK checksum mismatch' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $target = Join-Path $Stage 'resources/browser'
  New-Item -ItemType Directory -Force $target | Out-Null
  foreach ($entry in @('build/native/x64/WebView2Loader.dll', 'LICENSE.txt')) {
    $source = $zip.GetEntry($entry)
    if (-not $source) { throw "Locked WebView2 SDK is missing $entry" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($source, (Join-Path $target (Split-Path $entry -Leaf)), $true)
  }
} finally { $zip.Dispose() }
