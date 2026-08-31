param([switch]$Worker)

$ErrorActionPreference = "SilentlyContinue"

if (-not $Worker) {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $startInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Worker"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  if (-not [Diagnostics.Process]::Start($startInfo)) {
    exit 3
  }
  exit 0
}

$oldPath = $env:DSH_DESKTOP_CLEAN_OLD
$emptyPath = $env:DSH_DESKTOP_CLEAN_EMPTY
$logDir = $env:DSH_DESKTOP_CLEAN_LOG_DIR
if ([string]::IsNullOrWhiteSpace($logDir)) {
  $logDir = Join-Path $env:APPDATA "StarWeave\logs"
}
$logPath = Join-Path $logDir "installer-cleanup.log"

New-Item -ItemType Directory -Force $logDir | Out-Null
Add-Content -LiteralPath $logPath -Value "cleanup start: old=$oldPath"

try {
  if ([string]::IsNullOrWhiteSpace($oldPath) -or [string]::IsNullOrWhiteSpace($emptyPath)) {
    Add-Content -LiteralPath $logPath -Value "cleanup failed: required paths are missing"
    exit 2
  }
  New-Item -ItemType Directory -Force $emptyPath | Out-Null
  $robocopyInfo = [Diagnostics.ProcessStartInfo]::new()
  $robocopyInfo.FileName = "$env:SystemRoot\System32\robocopy.exe"
  $robocopyInfo.Arguments = "`"$emptyPath`" `"$oldPath`" /MIR /R:0 /W:0 /NFL /NDL /NJH /NJS /NP"
  $robocopyInfo.UseShellExecute = $false
  $robocopyInfo.CreateNoWindow = $true
  $robocopyInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $robocopy = [Diagnostics.Process]::Start($robocopyInfo)
  if ($null -eq $robocopy) {
    Add-Content -LiteralPath $logPath -Value "cleanup failed: unable to start robocopy"
    exit 3
  }
  $robocopy.WaitForExit()
  $robocopyExitCode = $robocopy.ExitCode
  $robocopy.Dispose()
  Add-Content -LiteralPath $logPath -Value "robocopy exit code: $robocopyExitCode"
  if ($robocopyExitCode -lt 8) {
    Remove-Item -LiteralPath $oldPath -Force
    Add-Content -LiteralPath $logPath -Value "cleanup complete"
  }
} finally {
  Remove-Item -LiteralPath $emptyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
