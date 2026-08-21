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
$pluginTarget = Join-Path $stage "resources/plugin"
$marketplaceTarget = Join-Path $stage "resources/marketplace"
$seedSourceTarget = Join-Path $stage ("resources/seed/source/" + $seedLock.commit)
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
$pnpmScript = Join-Path $tools "pnpm/dist/pnpm.mjs"
$git = Join-Path $tools "git/cmd/git.exe"
foreach ($required in $node,$pnpm,$pnpmScript,$git) {
  if (-not (Test-Path $required)) { throw "Missing embedded tool: $required" }
}
if ((& $node --version).TrimStart('v') -ne $seedLock.node) { throw "Embedded Node version mismatch" }
if ((& $node $pnpmScript --version) -ne $seedLock.pnpm) { throw "Embedded pnpm version mismatch" }
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
$savedErrorPreference = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
$previousCommit = (& $git -C $checkout rev-parse --verify HEAD 2>$null)
$previousCommitExitCode = $LASTEXITCODE
$ErrorActionPreference = $savedErrorPreference
if ($previousCommitExitCode -eq 0) {
  $previousCommit = $previousCommit.Trim()
  & $git -C $checkout reset --hard HEAD
  if ($LASTEXITCODE -ne 0) { throw "Unable to reset cached Harness checkout" }
} else {
  $previousCommit = ""
}
& $git -C $checkout clean -fdx -e node_modules/
if ($LASTEXITCODE -ne 0) { throw "Unable to clean cached Harness checkout" }
& $git -C $checkout fetch --force --no-tags --depth 1 origin $seedLock.commit
if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit fetch failed" }
& $git -C $checkout checkout --detach $seedLock.commit
if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit checkout failed" }
& $git -C $checkout reset --hard $seedLock.commit
if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit reset failed" }
if ($previousCommit -ne $seedLock.commit) {
  $cachedNodeModules = Join-Path $checkout "node_modules"
  if (Test-Path $cachedNodeModules) {
    & cmd.exe /d /c rmdir /s /q "\\?\$cachedNodeModules"
    if ($LASTEXITCODE -ne 0 -or (Test-Path $cachedNodeModules)) { throw "Unable to remove stale Harness node_modules" }
  }
  & $git -C $checkout clean -fdx
} else {
  & $git -C $checkout clean -fdx -e node_modules/
}
if ($LASTEXITCODE -ne 0) { throw "Harness worktree cleanup failed" }
$desktopOverlay = Join-Path $checkout "packages/desktop"
if (Test-Path $desktopOverlay) { & cmd.exe /d /c rmdir /s /q $desktopOverlay }
$resolved = (& $git -C $checkout rev-parse HEAD).Trim()
if ($resolved -ne $seedLock.commit) { throw "Harness commit mismatch: $resolved" }
$pkg = Get-Content (Join-Path $checkout "package.json") -Raw | ConvertFrom-Json
if ($pkg.packageManager -ne ("pnpm@" + $seedLock.pnpm)) { throw "Harness packageManager changed" }

$cleanHome = Join-Path $buildRoot "clean-home"; New-Item -ItemType Directory -Force $cleanHome | Out-Null
$env:HOME = $cleanHome; $env:USERPROFILE = $cleanHome; $env:GIT_TERMINAL_PROMPT = "0"; $env:CI = "1"
$env:PATH = ((Join-Path $tools "node"),(Join-Path $tools "pnpm"),(Join-Path $tools "git/cmd"),(Join-Path $env:SystemRoot "System32"),(Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0")) -join ";"
Remove-Item Env:SSH_AUTH_SOCK -ErrorAction SilentlyContinue
Get-ChildItem Env: | Where-Object { $_.Name -match '(TOKEN|SECRET|PASSWORD|API_KEY|OPENAI|ANTHROPIC|DEEPSEEK)' } | ForEach-Object { Remove-Item ("Env:" + $_.Name) -ErrorAction SilentlyContinue }
Push-Location $checkout
try {
  & $node $pnpmScript install --frozen-lockfile `
    --store-dir (Join-Path $buildRoot "pnpm-store") `
    --fetch-retries 5 `
    --fetch-retry-mintimeout 10000 `
    --fetch-retry-maxtimeout 120000 `
    --fetch-timeout 300000 `
    --network-concurrency 8
  if ($LASTEXITCODE -ne 0) { throw "Frozen seed install failed" }
  & $node $pnpmScript run build:official
  if ($LASTEXITCODE -ne 0) { throw "Official seed build failed" }
} finally {
  Pop-Location
}
if (-not (Test-Path (Join-Path $checkout $seedLock.cliEntry))) { throw "Built CLI entry is missing" }

$seedSourceParent = Split-Path -Parent $seedSourceTarget
if (Test-Path $seedSourceTarget) {
  & $node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })" $seedSourceTarget
  if ($LASTEXITCODE -ne 0 -or (Test-Path $seedSourceTarget)) { throw "Unable to clear previous staged seed source" }
}
New-Item -ItemType Directory -Force $seedSourceParent | Out-Null
& $node (Join-Path $repoRoot "scripts/stage-workspace-runtime.mjs") $checkout $seedSourceTarget
if ($LASTEXITCODE -ne 0) { throw "Compiled workspace runtime staging failed" }
if (-not (Test-Path (Join-Path $seedSourceTarget $seedLock.cliEntry))) { throw "Staged CLI entry is missing" }
$stagedNodeModules = Get-ChildItem $seedSourceTarget -Directory -Recurse -Filter node_modules | Select-Object -First 1
if ($stagedNodeModules) { throw "Installable seed must not contain node_modules: $($stagedNodeModules.FullName)" }

$smokeRuntime = Join-Path $buildRoot "install-smoke-runtime"
if (Test-Path $smokeRuntime) {
  & $node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })" $smokeRuntime
  if ($LASTEXITCODE -ne 0 -or (Test-Path $smokeRuntime)) { throw "Unable to clear install smoke runtime" }
}
$smokeDeploy = Join-Path $smokeRuntime "apps/cli"
& $node $pnpmScript `
  --config.inject-workspace-packages=true `
  --config.node-linker=hoisted `
  --config.strict-dep-builds=false `
  --store-dir (Join-Path $buildRoot "pnpm-store") `
  --dir $seedSourceTarget `
  --filter "@deepseek-ai/dsh" `
  --prod `
  --frozen-lockfile `
  --offline `
  deploy $smokeDeploy
if ($LASTEXITCODE -ne 0) { throw "Installable seed deploy smoke failed" }
& $node (Join-Path $repoRoot "scripts/materialize-workspace-runtime.mjs") $seedSourceTarget $smokeDeploy
if ($LASTEXITCODE -ne 0) { throw "Installable seed workspace materialization failed" }
$savedErrorPreference = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
$reparsePoints = @(& cmd.exe /d /c dir /s /a:l /b "$smokeRuntime\*" 2>$null)
$reparseScanExitCode = $LASTEXITCODE
$ErrorActionPreference = $savedErrorPreference
if ($reparseScanExitCode -notin 0,1) { throw "Unable to scan installed smoke runtime for reparse points (exit code $reparseScanExitCode)" }
$reparsePoint = $reparsePoints | Select-Object -First 1
if ($reparsePoint) { throw "Installed smoke runtime contains a non-relocatable reparse point: $reparsePoint" }

$smokeHome = Join-Path $buildRoot "smoke-home"; Remove-Item -Recurse -Force $smokeHome -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $smokeHome | Out-Null
$control = Join-Path $repoRoot "internal/desktop/child-control.mjs"
$controlImport = [Uri]::new($control).AbsoluteUri
$cli = Join-Path $smokeRuntime $seedLock.cliEntry
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $node
$psi.Arguments = "--import `"$controlImport`" `"$cli`" --profile web --no-open --host 127.0.0.1 --port 0"
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
& $node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })" $smokeRuntime
if ($LASTEXITCODE -ne 0 -or (Test-Path $smokeRuntime)) { throw "Unable to remove installed smoke runtime" }

$seedSourceRoot = Join-Path $stage "resources/seed/source"
Get-ChildItem $seedSourceRoot -Directory | Where-Object { $_.Name -ne $seedLock.commit } | ForEach-Object {
  $longPath = if ($_.FullName.StartsWith('\\?\')) { $_.FullName } else { '\\?\' + $_.FullName }
  & cmd.exe /d /c rmdir /s /q $longPath
  if ($LASTEXITCODE -ne 0 -or (Test-Path $_.FullName)) { throw "Unable to remove stale staged seed source: $($_.FullName)" }
}
$seedRuntimeRoot = Join-Path $stage "resources/seed/runtime"
if (Test-Path $seedRuntimeRoot) {
  Get-ChildItem $seedRuntimeRoot -Directory | ForEach-Object {
    $longPath = if ($_.FullName.StartsWith('\\?\')) { $_.FullName } else { '\\?\' + $_.FullName }
    & cmd.exe /d /c rmdir /s /q $longPath
    if ($LASTEXITCODE -ne 0 -or (Test-Path $_.FullName)) { throw "Unable to remove packaged seed runtime: $($_.FullName)" }
  }
}

$pluginSource = Join-Path $repoRoot "plugin"
$pluginBuild = Join-Path $pluginSource "scripts/build-against-harness.mjs"
$marketplaceCatalog = Join-Path $pluginSource "catalog/catalog.json"
$marketplaceSignature = Join-Path $pluginSource "catalog/catalog.sig"
$pluginPackages = @(
  @{ directory = "plugin-host"; name = "@run-bigpig/dsh-desktop-plugin-host" },
  @{ directory = "plugin-client"; name = "@run-bigpig/dsh-desktop-plugin-client" },
  @{ directory = "plugin-bundle"; name = "@run-bigpig/dsh-desktop-plugin" }
)
foreach ($required in $pluginBuild,$marketplaceCatalog,$marketplaceSignature) {
  if (-not (Test-Path $required)) { throw "Built-in Desktop Plugin source is incomplete: $required" }
}
$pluginVersion = $null
foreach ($package in $pluginPackages) {
  $manifestPath = Join-Path $pluginSource ("packages/" + $package.directory + "/package.json")
  if (-not (Test-Path $manifestPath)) { throw "Built-in Desktop Plugin source is incomplete: $manifestPath" }
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.name -ne $package.name) { throw "Built-in Desktop Plugin package name mismatch: $manifestPath" }
  if ($null -eq $pluginVersion) { $pluginVersion = $manifest.version }
  if ($manifest.version -ne $pluginVersion) { throw "Built-in Desktop Plugin package versions do not match" }
}
& $node $pluginBuild --harness $checkout --out $pluginTarget
if ($LASTEXITCODE -ne 0) { throw "Desktop Plugin build failed" }
foreach ($package in $pluginPackages) {
  $builtManifestPath = Join-Path $pluginTarget ($package.directory + "/package.json")
  if (-not (Test-Path $builtManifestPath)) { throw "Built-in Desktop Plugin package is missing: $builtManifestPath" }
  $builtManifestText = Get-Content $builtManifestPath -Raw
  $builtManifest = $builtManifestText | ConvertFrom-Json
  if ($builtManifest.name -ne $package.name -or $builtManifest.version -ne $pluginVersion) {
    throw "Built-in Desktop Plugin package identity mismatch: $builtManifestPath"
  }
  if ($builtManifestText -match 'workspace:') { throw "Built-in Desktop Plugin contains an unpublished workspace dependency: $builtManifestPath" }
}

$buildPathMarkers = @(
  $checkout,
  $checkout.Replace('\', '/'),
  $checkout.Replace('\', '\\')
) | Select-Object -Unique
foreach ($root in $seedSourceTarget,$pluginTarget) {
  Get-ChildItem $root -Recurse -File | Where-Object { $_.Name -match '\.(?:[cm]?js|map|ts)$' } | ForEach-Object {
    $text = [IO.File]::ReadAllText($_.FullName)
    $sanitized = $text
    foreach ($marker in $buildPathMarkers) { $sanitized = $sanitized.Replace($marker, '<harness-build>') }
    if ($sanitized -ne $text) {
      [IO.File]::WriteAllText($_.FullName, $sanitized, [Text.UTF8Encoding]::new($false))
    }
  }
}
if (Test-Path $marketplaceTarget) { & cmd.exe /d /c rmdir /s /q $marketplaceTarget }
New-Item -ItemType Directory -Force $marketplaceTarget | Out-Null
Get-Content $marketplaceCatalog -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
Copy-Item -Force $marketplaceCatalog (Join-Path $marketplaceTarget "catalog.json")
Copy-Item -Force $marketplaceSignature (Join-Path $marketplaceTarget "catalog.sig")

New-Item -ItemType Directory -Force $runtimeTools | Out-Null
$runtimeNode = Join-Path $runtimeTools "node"
New-Item -ItemType Directory -Force $runtimeNode | Out-Null
Copy-Item -Force $node (Join-Path $runtimeNode "node.exe")
Copy-Item -Force (Join-Path $tools "node/LICENSE") (Join-Path $runtimeNode "LICENSE")
Copy-Item -Recurse -Force (Join-Path $tools "pnpm") (Join-Path $runtimeTools "pnpm")
Copy-Item -Force (Join-Path $repoRoot "release/seed.lock.json") (Join-Path $stage "resources/seed/seed.lock.json")
Write-Host "Verified installable Harness workspace seed, source-built Desktop Plugin, and Marketplace catalog staged at $seedSourceTarget"
