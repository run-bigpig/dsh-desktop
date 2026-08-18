$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolLock = Get-Content (Join-Path $repoRoot "release/toolchain.lock.json") -Raw | ConvertFrom-Json
$seedLock = Get-Content (Join-Path $repoRoot "release/seed.lock.json") -Raw | ConvertFrom-Json
$stage = Join-Path $repoRoot "dist/windows/stage"
$downloads = Join-Path $repoRoot "dist/windows/downloads"
$buildRoot = Join-Path $repoRoot "dist/windows/seed-build"
$tools = Join-Path $buildRoot "toolchain"
$runtimeTools = Join-Path $stage "resources/toolchain"
$seedTarget = Join-Path $stage ("resources/seed/runtime/" + $seedLock.commit)
Remove-Item -Recurse -Force $tools -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $runtimeTools -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage,$downloads,$tools,$buildRoot | Out-Null

function Get-VerifiedArtifact($artifact) {
  if ($artifact.sha256 -notmatch '^[0-9a-f]{64}$') { throw "Invalid SHA-256 lock for $($artifact.name)" }
  $target = Join-Path $downloads ([IO.Path]::GetFileName($artifact.url))
  if (-not (Test-Path $target)) { Invoke-WebRequest -UseBasicParsing $artifact.url -OutFile $target }
  $actual = (Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant()
  if ($actual -ne $artifact.sha256) { throw "SHA-256 mismatch for $($artifact.name): expected $($artifact.sha256), got $actual" }
  return $target
}

foreach ($artifact in $toolLock.artifacts) {
  if ($artifact.platform -ne "windows" -or $artifact.architecture -ne "x64") { continue }
  $archive = Get-VerifiedArtifact $artifact
  switch ($artifact.name) {
    "node" {
      $temp = Join-Path $buildRoot "node-extract"; Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue; Expand-Archive $archive $temp
      $nodeSource = Get-ChildItem $temp -Directory | Select-Object -First 1
      Copy-Item -Recurse -Force $nodeSource.FullName (Join-Path $tools "node")
    }
    "pnpm" {
      $pnpmDir = Join-Path $tools "pnpm"; New-Item -ItemType Directory -Force $pnpmDir | Out-Null; Expand-Archive -Force $archive $pnpmDir
      $pnpmExe = Get-ChildItem $pnpmDir -Recurse -Filter "pnpm.exe" | Select-Object -First 1
      if (-not $pnpmExe) { throw "pnpm.exe missing from locked archive" }
      if ($pnpmExe.DirectoryName -ne $pnpmDir) { Copy-Item -Force $pnpmExe.FullName (Join-Path $pnpmDir "pnpm.exe") }
    }
    "git" {
      $gitDir = Join-Path $tools "git"
      $extractExitCode = -1
      foreach ($attempt in 1..3) {
        if (Test-Path $gitDir) { & cmd.exe /d /c rmdir /s /q $gitDir }
        New-Item -ItemType Directory -Force $gitDir | Out-Null
        $extract = Start-Process -FilePath $archive -ArgumentList @("-y", ("-o" + $gitDir)) -Wait -PassThru
        $extractExitCode = $extract.ExitCode
        if ($extractExitCode -eq 0) { break }
        Write-Warning "PortableGit extraction attempt $attempt failed with exit code $extractExitCode"
      }
      if ($extractExitCode -ne 0) { throw "PortableGit extraction failed after 3 attempts" }
    }
  }
}

$node = Join-Path $tools "node/node.exe"
$pnpm = Join-Path $tools "pnpm/pnpm.exe"
$git = Join-Path $tools "git/cmd/git.exe"
foreach ($required in $node,$pnpm,$git) { if (-not (Test-Path $required)) { throw "Missing embedded tool: $required" } }
if ((& $node --version).TrimStart('v') -ne $seedLock.node) { throw "Embedded Node version mismatch" }
if ((& $pnpm --version) -ne $seedLock.pnpm) { throw "Embedded pnpm version mismatch" }
$lockedGit = $toolLock.artifacts | Where-Object { $_.name -eq "git" -and $_.platform -eq "windows" -and $_.architecture -eq "x64" } | Select-Object -First 1
if (-not $lockedGit -or ((& $git --version).Trim() -ne ("git version " + $lockedGit.version))) { throw "Embedded Git version mismatch" }

$checkout = Join-Path $buildRoot "harness"
$validRepository = $false
if (Test-Path (Join-Path $checkout ".git")) {
  & $git -C $checkout rev-parse --git-dir *> $null
  $validRepository = $LASTEXITCODE -eq 0
}
if (-not $validRepository) {
  if (Test-Path $checkout) { & cmd.exe /d /c rmdir /s /q $checkout }
  New-Item -ItemType Directory -Force $checkout | Out-Null
  & $git -C $checkout init
  if ($LASTEXITCODE -ne 0) { throw "Harness repository initialization failed" }
  & $git -C $checkout remote add origin $seedLock.repository
  if ($LASTEXITCODE -ne 0) { throw "Unable to configure locked Harness remote" }
} else {
  & $git -C $checkout remote get-url origin *> $null
  if ($LASTEXITCODE -eq 0) {
    & $git -C $checkout remote set-url origin $seedLock.repository
  } else {
    & $git -C $checkout remote add origin $seedLock.repository
  }
  if ($LASTEXITCODE -ne 0) { throw "Unable to restore locked Harness remote" }
}
& $git -C $checkout fetch --force --no-tags --depth 1 origin $seedLock.commit
if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit fetch failed" }
& $git -C $checkout checkout --detach $seedLock.commit
if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit checkout failed" }
& $git -C $checkout reset --hard $seedLock.commit
if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit reset failed" }
& $git -C $checkout clean -fdx -e node_modules/
if ($LASTEXITCODE -ne 0) { throw "Harness worktree cleanup failed" }
$resolved = (& $git -C $checkout rev-parse HEAD).Trim()
if ($resolved -ne $seedLock.commit) { throw "Harness commit mismatch: $resolved" }
$pkg = Get-Content (Join-Path $checkout "package.json") -Raw | ConvertFrom-Json
if ($pkg.packageManager -ne ("pnpm@" + $seedLock.pnpm)) { throw "Harness packageManager changed" }

$cleanHome = Join-Path $buildRoot "clean-home"; New-Item -ItemType Directory -Force $cleanHome | Out-Null
$env:HOME = $cleanHome; $env:USERPROFILE = $cleanHome; $env:GIT_TERMINAL_PROMPT = "0"; $env:CI = "1"
$env:PATH = ((Join-Path $tools "node"),(Join-Path $tools "pnpm"),(Join-Path $tools "git/cmd"),(Join-Path $env:SystemRoot "System32"),(Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0")) -join ";"
Remove-Item Env:SSH_AUTH_SOCK -ErrorAction SilentlyContinue
Get-ChildItem Env: | Where-Object { $_.Name -match '(TOKEN|SECRET|PASSWORD|API_KEY|OPENAI|ANTHROPIC|DEEPSEEK)' } | ForEach-Object { Remove-Item ("Env:" + $_.Name) -ErrorAction SilentlyContinue }
& $pnpm --dir $checkout install --frozen-lockfile `
  --store-dir (Join-Path $buildRoot "pnpm-store") `
  --fetch-retries 5 `
  --fetch-retry-mintimeout 10000 `
  --fetch-retry-maxtimeout 120000 `
  --fetch-timeout 300000 `
  --network-concurrency 8
if ($LASTEXITCODE -ne 0) { throw "Frozen seed install failed" }
& $pnpm --dir $checkout run build
if ($LASTEXITCODE -ne 0) { throw "Seed build failed" }
if (-not (Test-Path (Join-Path $checkout $seedLock.cliEntry))) { throw "Built CLI entry is missing" }

$seedParent = Split-Path -Parent $seedTarget
if (Test-Path $seedTarget) {
  & $node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })" $seedTarget
  if ($LASTEXITCODE -ne 0 -or (Test-Path $seedTarget)) { throw "Unable to clear previous staged seed runtime" }
}
New-Item -ItemType Directory -Force $seedParent | Out-Null
$deployTarget = Join-Path $seedTarget "apps/cli"
& $pnpm `
  --config.inject-workspace-packages=true `
  --config.node-linker=hoisted `
  --config.strict-dep-builds=false `
  --store-dir (Join-Path $buildRoot "pnpm-store") `
  --dir $checkout `
  --filter "@deepseek-ai/dsh" `
  --prod `
  --frozen-lockfile `
  --offline `
  deploy $deployTarget
if ($LASTEXITCODE -ne 0) { throw "Locked production seed deployment failed" }
if (-not (Test-Path (Join-Path $seedTarget $seedLock.cliEntry))) { throw "Deployed CLI entry is missing" }
& $node (Join-Path $repoRoot "scripts/stage-workspace-runtime.mjs") $checkout $deployTarget
if ($LASTEXITCODE -ne 0) { throw "Workspace runtime staging failed" }
$savedErrorPreference = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
$reparsePoints = @(& cmd.exe /d /c dir /s /a:l /b "$seedTarget\*" 2>$null)
$reparseScanExitCode = $LASTEXITCODE
$ErrorActionPreference = $savedErrorPreference
if ($reparseScanExitCode -notin 0,1) { throw "Unable to scan staged seed for reparse points (exit code $reparseScanExitCode)" }
$reparsePoint = $reparsePoints | Select-Object -First 1
if ($reparsePoint) { throw "Staged seed contains a non-relocatable reparse point: $reparsePoint" }

$smokeHome = Join-Path $buildRoot "smoke-home"; Remove-Item -Recurse -Force $smokeHome -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $smokeHome | Out-Null
$control = Join-Path $repoRoot "internal/desktop/child-control.mjs"
$controlImport = [Uri]::new($control).AbsoluteUri
$cli = Join-Path $seedTarget $seedLock.cliEntry
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $node
$psi.Arguments = "--import `"$controlImport`" `"$cli`" --profile web --host 127.0.0.1 --port 0"
$psi.WorkingDirectory = $buildRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.EnvironmentVariables["DSH_HOME"] = $smokeHome
$smoke = [Diagnostics.Process]::new(); $smoke.StartInfo = $psi
if (-not $smoke.Start()) { throw "Unable to start seed smoke process" }
$lines = [Collections.ArrayList]::new()
$stdoutOpen = $true; $stderrOpen = $true
$stdoutRead = $smoke.StandardOutput.ReadLineAsync(); $stderrRead = $smoke.StandardError.ReadLineAsync()
$deadline = [DateTime]::UtcNow.AddSeconds(45); $readyUrl = $null
while ([DateTime]::UtcNow -lt $deadline -and -not $smoke.HasExited) {
  if ($stdoutOpen -and $stdoutRead.IsCompleted) {
    $line = $stdoutRead.GetAwaiter().GetResult()
    if ($null -eq $line) { $stdoutOpen = $false } else {
      [void]$lines.Add($line)
      if ($line -match '^dsh web: (http://127\.0\.0\.1:[0-9]{1,5})$') { $readyUrl = $Matches[1] }
      $stdoutRead = $smoke.StandardOutput.ReadLineAsync()
    }
  }
  if ($stderrOpen -and $stderrRead.IsCompleted) {
    $line = $stderrRead.GetAwaiter().GetResult()
    if ($null -eq $line) { $stderrOpen = $false } else {
      [void]$lines.Add($line)
      if ($line -match '^dsh web: (http://127\.0\.0\.1:[0-9]{1,5})$') { $readyUrl = $Matches[1] }
      $stderrRead = $smoke.StandardError.ReadLineAsync()
    }
  }
  if ($readyUrl) { break }; Start-Sleep -Milliseconds 50
}
if (-not $readyUrl -and $smoke.HasExited) {
  while ($stdoutOpen) {
    $line = $stdoutRead.GetAwaiter().GetResult()
    if ($null -eq $line) { $stdoutOpen = $false; break }
    [void]$lines.Add($line)
    if ($line -match '^dsh web: (http://127\.0\.0\.1:[0-9]{1,5})$') { $readyUrl = $Matches[1] }
    $stdoutRead = $smoke.StandardOutput.ReadLineAsync()
  }
  while ($stderrOpen) {
    $line = $stderrRead.GetAwaiter().GetResult()
    if ($null -eq $line) { $stderrOpen = $false; break }
    [void]$lines.Add($line)
    if ($line -match '^dsh web: (http://127\.0\.0\.1:[0-9]{1,5})$') { $readyUrl = $Matches[1] }
    $stderrRead = $smoke.StandardError.ReadLineAsync()
  }
}
if (-not $readyUrl) {
  if ($smoke.HasExited) { $smoke.WaitForExit() } else { & taskkill /PID $smoke.Id /T /F | Out-Null }
  @($lines) | ForEach-Object { Write-Warning ("Harness smoke: " + $_) }
  throw "Seed smoke did not publish a strict loopback ready URL"
}
$homePage = Invoke-WebRequest -UseBasicParsing -Uri $readyUrl -TimeoutSec 8
if ($homePage.Content -notmatch 'window\.__DSH_BOOT__') { & taskkill /PID $smoke.Id /T /F | Out-Null; throw "Seed smoke homepage is missing window.__DSH_BOOT__" }
$smoke.StandardInput.WriteLine('{"type":"shutdown","source":"release-smoke"}'); $smoke.StandardInput.Close()
if (-not $smoke.WaitForExit(10000)) { & taskkill /PID $smoke.Id /T /F | Out-Null; throw "Seed smoke did not shut down gracefully" }
if ($smoke.ExitCode -ne 0) { throw "Seed smoke exited with code $($smoke.ExitCode)" }

New-Item -ItemType Directory -Force $runtimeTools | Out-Null
Copy-Item -Recurse -Force (Join-Path $tools "node") (Join-Path $runtimeTools "node")
Copy-Item -Force (Join-Path $repoRoot "release/seed.lock.json") (Join-Path $stage "resources/seed/seed.lock.json")
Write-Host "Verified offline seed staged at $seedTarget"
