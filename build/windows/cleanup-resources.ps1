param([switch]$Worker)

$ErrorActionPreference = "SilentlyContinue"

if (-not $Worker) {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $startInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Worker"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  if (-not [Diagnostics.Process]::Start($startInfo)) {
    exit 3
  }
  exit 0
}

$oldPath = $env:DSH_DESKTOP_CLEAN_OLD
$emptyPath = $env:DSH_DESKTOP_CLEAN_EMPTY
$logDir = Join-Path $env:APPDATA "DSH-DeskTop\logs"
$logPath = Join-Path $logDir "installer-cleanup.log"

New-Item -ItemType Directory -Force $logDir | Out-Null
Add-Content -LiteralPath $logPath -Value "cleanup start: old=$oldPath"

try {
  if ([string]::IsNullOrWhiteSpace($oldPath) -or [string]::IsNullOrWhiteSpace($emptyPath)) {
    Add-Content -LiteralPath $logPath -Value "cleanup failed: required paths are missing"
    exit 2
  }
  New-Item -ItemType Directory -Force $emptyPath | Out-Null
  & "$env:SystemRoot\System32\robocopy.exe" `
    $emptyPath $oldPath /MIR /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
  Add-Content -LiteralPath $logPath -Value "robocopy exit code: $LASTEXITCODE"
  if ($LASTEXITCODE -lt 8) {
    Remove-Item -LiteralPath $oldPath -Force
    Add-Content -LiteralPath $logPath -Value "cleanup complete"
  }
} finally {
  Remove-Item -LiteralPath $emptyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
