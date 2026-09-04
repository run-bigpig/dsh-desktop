$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "windows-build-common.ps1")
$buildLock = Enter-WindowsBuildLock $repoRoot
$toolLock = Get-Content (Join-Path $repoRoot "release/toolchain.lock.json") -Raw | ConvertFrom-Json
$seedLock = Get-Content (Join-Path $repoRoot "release/seed.lock.json") -Raw | ConvertFrom-Json
$designReleaseConfig = Get-Content (Join-Path $repoRoot "release/starweave-ui.release.json") -Raw | ConvertFrom-Json
$stage = Join-Path $repoRoot "dist/windows/stage"
$downloads = Join-Path $repoRoot "dist/windows/downloads"
$buildRoot = Join-Path $repoRoot "dist/windows/seed-build"
$tools = Join-Path $buildRoot "toolchain"
$runtimeTools = Join-Path $stage "resources/toolchain"
$pluginTarget = Join-Path $stage "resources/plugin"
$marketplaceTarget = Join-Path $stage "resources/marketplace"
$seedSourceTarget = Join-Path $stage ("resources/seed/source/" + $seedLock.commit)
$seedManifestPath = Join-Path $stage "resources/seed/build-manifest.json"
$seedCacheRoot = Join-Path $repoRoot "dist/windows/seed-cache"
$sourceSeedFingerprint = Get-WindowsSeedFingerprint $repoRoot
$designReleaseHeaders = @{
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "StarWeave-Windows-Seed"
}
$githubToken = [Environment]::GetEnvironmentVariable("STARWEAVE_UI_GITHUB_TOKEN")
if ([string]::IsNullOrWhiteSpace($githubToken)) {
  $githubToken = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN")
}
if (-not [string]::IsNullOrWhiteSpace($githubToken)) { $designReleaseHeaders.Authorization = "Bearer " + $githubToken }

function Get-LatestStarWeaveUIRelease {
  if (
    $designReleaseConfig.schemaVersion -ne 1 -or
    $designReleaseConfig.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
    $designReleaseConfig.releaseAPI -notmatch '^https://api\.github\.com/repos/' -or
    $designReleaseConfig.archiveAsset -ne 'starweave-ui-dist.tar.gz' -or
    $designReleaseConfig.checksumAsset -ne 'starweave-ui-dist.tar.gz.sha256'
  ) {
    throw "Invalid StarWeave UI release configuration"
  }
  try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri $designReleaseConfig.releaseAPI -Headers $designReleaseHeaders
  } catch {
    throw "Unable to resolve the latest StarWeave UI release. Push a stable vX.Y.Z tag first: $($_.Exception.Message)"
  }
  $tag = [string]$release.tag_name
  if ($release.draft -or $release.prerelease -or $tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "Latest StarWeave UI release is not a stable vX.Y.Z release: $tag"
  }
  $archiveAssets = @($release.assets | Where-Object { $_.name -ceq $designReleaseConfig.archiveAsset })
  $checksumAssets = @($release.assets | Where-Object { $_.name -ceq $designReleaseConfig.checksumAsset })
  if ($archiveAssets.Count -ne 1 -or $checksumAssets.Count -ne 1) {
    throw "StarWeave UI release $tag must contain exactly one archive and checksum asset"
  }
  $releaseBase = "https://github.com/$($designReleaseConfig.repository)/releases/download/$tag/"
  $archiveURL = [string]$archiveAssets[0].browser_download_url
  $checksumURL = [string]$checksumAssets[0].browser_download_url
  if ($archiveURL -cne ($releaseBase + $designReleaseConfig.archiveAsset) -or $checksumURL -cne ($releaseBase + $designReleaseConfig.checksumAsset)) {
    throw "StarWeave UI release $tag contains an unexpected asset URL"
  }
  $checksumResponse = Invoke-WebRequest -UseBasicParsing -Uri $checksumURL -Headers $designReleaseHeaders
  $checksumContent = if ($checksumResponse.Content -is [byte[]]) {
    [Text.Encoding]::UTF8.GetString($checksumResponse.Content)
  } else {
    [string]$checksumResponse.Content
  }
  $checksumMatch = [Text.RegularExpressions.Regex]::Match(
    $checksumContent,
    '^[\s]*([0-9a-fA-F]{64})[\s]+\*?starweave-ui-dist\.tar\.gz[\s]*$',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if (-not $checksumMatch.Success) { throw "StarWeave UI release $tag has an invalid checksum asset" }
  return [pscustomobject]@{
    tag = $tag
    repository = [string]$designReleaseConfig.repository
    archiveURL = $archiveURL
    archiveSHA256 = $checksumMatch.Groups[1].Value.ToLowerInvariant()
  }
}

$designRelease = Get-LatestStarWeaveUIRelease
$seedFingerprint = Get-SHA256Text ((@(
  "source=$sourceSeedFingerprint",
  "designTag=$($designRelease.tag)",
  "designSHA256=$($designRelease.archiveSHA256)"
) -join "`n"))
$seedCache = Join-Path $seedCacheRoot $seedFingerprint

function Get-DesktopPluginVersion {
  $versions = @(
    "plugin/packages/plugin-host/package.json",
    "plugin/packages/plugin-client/package.json",
    "plugin/packages/plugin-bundle/package.json"
  ) | ForEach-Object {
    (Get-Content (Join-Path $repoRoot $_) -Raw | ConvertFrom-Json).version
  } | Select-Object -Unique
  if (@($versions).Count -ne 1) { throw "Built-in Desktop Plugin package versions do not match" }
  return @($versions)[0]
}

function Get-HarnessReadyUrl([string]$Line) {
  $match = [Text.RegularExpressions.Regex]::Match(
    $Line,
    '^dsh web: (http://127\.0\.0\.1:[0-9]{1,5}/\?token=[A-Za-z0-9_-]{43})$',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if (-not $match.Success) { return $null }
  $value = $match.Groups[1].Value
  $uri = $null
  if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri)) { return $null }
  if ($uri.Scheme -cne 'http' -or $uri.Host -cne '127.0.0.1' -or $uri.Port -lt 1 -or $uri.Port -gt 65535) { return $null }
  if ($uri.UserInfo -ne '' -or $uri.AbsolutePath -cne '/' -or $uri.Query -cnotmatch '^\?token=[A-Za-z0-9_-]{43}$' -or $uri.Fragment -ne '') { return $null }
  return $value
}

function Test-VerifiedSeedLayout([string]$Root) {
  $manifestPath = Join-Path $Root "resources/seed/build-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) { return $false }
  try {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  } catch {
    return $false
  }
  if (
    $manifest.schemaVersion -ne 2 -or
    -not ($manifest.PSObject.Properties.Name -contains "sourceFingerprint") -or
    -not ($manifest.PSObject.Properties.Name -contains "designRelease") -or
    $null -eq $manifest.designRelease -or
    -not ($manifest.designRelease.PSObject.Properties.Name -contains "tag") -or
    -not ($manifest.designRelease.PSObject.Properties.Name -contains "sha256") -or
    -not ($manifest.designRelease.PSObject.Properties.Name -contains "commit")
  ) { return $false }
  if (
    $manifest.fingerprint -ne $seedFingerprint -or
    $manifest.sourceFingerprint -ne $sourceSeedFingerprint -or
    $manifest.commit -ne $seedLock.commit -or
    $manifest.designRelease.tag -ne $designRelease.tag -or
    $manifest.designRelease.sha256 -ne $designRelease.archiveSHA256
  ) { return $false }
  try {
    $designBuild = Get-Content (Join-Path $Root "resources/plugin/plugin-host/web/starweave-ui/starweave-ui-build.json") -Raw | ConvertFrom-Json
  } catch {
    return $false
  }
  if (
    $designBuild.schemaVersion -ne 1 -or
    $designBuild.tag -ne $manifest.designRelease.tag -or
    $designBuild.commit -ne $manifest.designRelease.commit
  ) { return $false }
  if (Test-Path -LiteralPath (Join-Path $Root "resources/openpencil")) { return $false }
  foreach ($required in @(
    "resources/toolchain/node/node.exe",
    "resources/toolchain/node/LICENSE",
    "resources/toolchain/pnpm/pnpm.exe",
    "resources/toolchain/pnpm/dist/pnpm.mjs",
    "resources/toolchain/pnpm/dist/pnpmrc",
    "resources/toolchain/pnpm/dist/worker.js",
    ("resources/seed/source/" + $seedLock.commit + "/" + $seedLock.cliEntry),
    "resources/plugin/plugin-host/package.json",
    "resources/plugin/plugin-host/lib/design.js",
    "resources/plugin/plugin-host/web/starweave-ui/index.html",
    "resources/plugin/plugin-host/web/starweave-ui/canvaskit.wasm",
    "resources/plugin/plugin-host/web/starweave-ui/starweave-ui-build.json",
    "resources/plugin/plugin-client/package.json",
    "resources/plugin/plugin-bundle/package.json",
    "resources/marketplace/catalog.json",
    "resources/marketplace/catalog.sig"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $required))) { return $false }
  }
  return $true
}

function Restore-VerifiedSeedCache([string]$Cache) {
  $stageResources = Join-Path $stage "resources"
  New-Item -ItemType Directory -Force $stageResources | Out-Null
  Remove-DirectoryTree (Join-Path $stageResources "openpencil")
  foreach ($directory in "toolchain","seed","plugin","marketplace") {
    Remove-DirectoryTree (Join-Path $stageResources $directory)
    Copy-DirectoryTree `
      -Source (Join-Path $Cache ("resources/" + $directory)) `
      -Destination (Join-Path $stageResources $directory)
  }
}

function Publish-VerifiedSeedCache {
  Get-ChildItem -LiteralPath $seedCacheRoot -Directory -Filter "seed-cache-tmp-*" | ForEach-Object {
    Remove-DirectoryTree $_.FullName
  }
  $temporaryCache = Join-Path $seedCacheRoot ("seed-cache-tmp-" + [Guid]::NewGuid().ToString("N"))
  $temporaryResources = Join-Path $temporaryCache "resources"
  New-Item -ItemType Directory -Force $temporaryResources | Out-Null
  foreach ($directory in "toolchain","seed","plugin","marketplace") {
    Copy-DirectoryTree `
      -Source (Join-Path $stage ("resources/" + $directory)) `
      -Destination (Join-Path $temporaryResources $directory)
  }
  if (Test-Path -LiteralPath $seedCache) { Remove-DirectoryTree $seedCache }
  Move-Item -LiteralPath $temporaryCache -Destination $seedCache
}

New-Item -ItemType Directory -Force $stage,$downloads,$buildRoot,$seedCacheRoot | Out-Null
if (Test-VerifiedSeedLayout $stage) {
  if (-not (Test-VerifiedSeedLayout $seedCache)) {
    Publish-VerifiedSeedCache
    Write-Host "Published verified Windows seed cache $seedFingerprint from the current stage"
  }
  $buildLock.Dispose()
  Write-Host "Verified Windows seed stage is current; skipping Harness rebuild ($seedFingerprint)"
  exit 0
}
if (Test-VerifiedSeedLayout $seedCache) {
  Restore-VerifiedSeedCache $seedCache
  $buildLock.Dispose()
  Write-Host "Restored verified Windows seed cache $seedFingerprint"
  exit 0
}
Get-ChildItem -LiteralPath $seedCacheRoot -Directory -Filter "seed-cache-tmp-*" | ForEach-Object {
  Remove-DirectoryTree $_.FullName
}
Remove-Item -LiteralPath $seedManifestPath -Force -ErrorAction SilentlyContinue
Remove-DirectoryTree (Join-Path $stage "resources/openpencil")
Remove-DirectoryTree $tools
Remove-DirectoryTree $runtimeTools
New-Item -ItemType Directory -Force $tools | Out-Null

function Get-VerifiedArtifact($artifact) {
  if ($artifact.sha256 -notmatch '^[0-9a-f]{64}$') { throw "Invalid SHA-256 lock for $($artifact.name)" }
  $target = Join-Path $downloads ([IO.Path]::GetFileName($artifact.url))
  if (-not (Test-Path $target)) { Invoke-WebRequest -UseBasicParsing $artifact.url -OutFile $target }
  $actual = Get-SHA256File $target
  if ($actual -ne $artifact.sha256) { throw "SHA-256 mismatch for $($artifact.name): expected $($artifact.sha256), got $actual" }
  return $target
}

foreach ($artifact in $toolLock.artifacts) {
  if ($artifact.platform -ne "windows" -or $artifact.architecture -ne "x64") { continue }
  $archive = Get-VerifiedArtifact $artifact
  switch ($artifact.name) {
    "node" {
      $temp = Join-Path $buildRoot "node-extract"; Remove-DirectoryTree $temp; Expand-Archive $archive $temp
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
function Initialize-FreshHarnessCheckout {
  $detachedCheckout = $null
  if (Test-Path -LiteralPath $checkout) {
    $detachedCheckout = Join-Path $buildRoot ("harness-stale-" + [Guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $checkout -Destination $detachedCheckout
  }
  New-Item -ItemType Directory -Force $checkout | Out-Null
  & $git -C $checkout init
  if ($LASTEXITCODE -ne 0) { throw "Harness repository initialization failed" }
  & $git -C $checkout remote add origin $seedLock.repository
  if ($LASTEXITCODE -ne 0) { throw "Unable to configure locked Harness remote" }
  & $git -C $checkout fetch --force --no-tags --depth 1 origin $seedLock.commit
  if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit fetch failed" }
  & $git -C $checkout checkout --detach $seedLock.commit
  if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit checkout failed" }
  & $git -C $checkout reset --hard $seedLock.commit
  if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit reset failed" }
  if ($detachedCheckout) { Remove-DetachedDirectoryTree $detachedCheckout }
}

$validRepository = $false
if (Test-Path (Join-Path $checkout ".git")) {
  & $git -C $checkout rev-parse --git-dir *> $null
  $validRepository = $LASTEXITCODE -eq 0
  if ($validRepository) {
    foreach ($lockName in "shallow.lock","index.lock","config.lock","HEAD.lock","packed-refs.lock") {
      if (Test-Path -LiteralPath (Join-Path $checkout (".git/" + $lockName))) {
        Write-Warning "Cached Harness checkout contains a stale Git lock; replacing the generated checkout"
        $validRepository = $false
        break
      }
    }
  }
}
$previousCommit = ""
if ($validRepository) {
  & $git -C $checkout remote get-url origin *> $null
  if ($LASTEXITCODE -eq 0) {
    & $git -C $checkout remote set-url origin $seedLock.repository
  } else {
    & $git -C $checkout remote add origin $seedLock.repository
  }
  if ($LASTEXITCODE -ne 0) { throw "Unable to restore locked Harness remote" }
  $savedErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  $previousCommit = (& $git -C $checkout rev-parse --verify HEAD 2>$null)
  $previousCommitExitCode = $LASTEXITCODE
  $ErrorActionPreference = $savedErrorPreference
  if ($previousCommitExitCode -eq 0) { $previousCommit = $previousCommit.Trim() } else { $previousCommit = "" }
}
if ($previousCommit -eq $seedLock.commit) {
  & $git -C $checkout reset --hard HEAD
  if ($LASTEXITCODE -ne 0) { throw "Unable to reset cached Harness checkout" }
  & $git -C $checkout clean -fdx -e node_modules/
  if ($LASTEXITCODE -ne 0) { throw "Unable to clean cached Harness checkout" }
  & $git -C $checkout fetch --force --no-tags --depth 1 origin $seedLock.commit
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Cached Harness checkout fetch failed; replacing the generated checkout"
    Initialize-FreshHarnessCheckout
  } else {
    & $git -C $checkout checkout --detach $seedLock.commit
    if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit checkout failed" }
    & $git -C $checkout reset --hard $seedLock.commit
    if ($LASTEXITCODE -ne 0) { throw "Locked Harness commit reset failed" }
    & $git -C $checkout clean -fdx -e node_modules/
    if ($LASTEXITCODE -ne 0) { throw "Harness worktree cleanup failed" }
  }
} else {
  Initialize-FreshHarnessCheckout
}
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
$installArguments = @(
  "install", "--frozen-lockfile",
  "--store-dir", (Join-Path $buildRoot "pnpm-store"),
  "--fetch-retries", "5",
  "--fetch-retry-mintimeout", "10000",
  "--fetch-retry-maxtimeout", "120000",
  "--fetch-timeout", "300000",
  "--network-concurrency", "8"
)
Push-Location $checkout
try {
  & $node $pnpmScript @installArguments
  $installExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($installExitCode -ne 0) {
  Write-Warning "Frozen seed install failed; replacing the generated Harness checkout and retrying once"
  Initialize-FreshHarnessCheckout
  Push-Location $checkout
  try {
    & $node $pnpmScript @installArguments
    $installExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
}
if ($installExitCode -ne 0) { throw "Frozen seed install failed after fresh-checkout recovery" }
Push-Location $checkout
try {
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
      $candidate = Get-HarnessReadyUrl $line
      if ($candidate) { $readyUrl = $candidate }
      $stdoutRead = $smoke.StandardOutput.ReadLineAsync()
    }
  }
  if ($stderrOpen -and $stderrRead.IsCompleted) {
    $line = $stderrRead.GetAwaiter().GetResult()
    if ($null -eq $line) { $stderrOpen = $false } else {
      [void]$lines.Add($line)
      $candidate = Get-HarnessReadyUrl $line
      if ($candidate) { $readyUrl = $candidate }
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
    $candidate = Get-HarnessReadyUrl $line
    if ($candidate) { $readyUrl = $candidate }
    $stdoutRead = $smoke.StandardOutput.ReadLineAsync()
  }
  while ($stderrOpen) {
    $line = $stderrRead.GetAwaiter().GetResult()
    if ($null -eq $line) { $stderrOpen = $false; break }
    [void]$lines.Add($line)
    $candidate = Get-HarnessReadyUrl $line
    if ($candidate) { $readyUrl = $candidate }
    $stderrRead = $smoke.StandardError.ReadLineAsync()
  }
}
if (-not $readyUrl) {
  if ($smoke.HasExited) { $smoke.WaitForExit() } else { & taskkill /PID $smoke.Id /T /F | Out-Null }
  @($lines) | ForEach-Object { Write-Warning ("Harness smoke: " + $_) }
  throw "Seed smoke did not publish a strict loopback ready URL"
}
$smokeSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$homePage = Invoke-WebRequest -UseBasicParsing -Uri $readyUrl -WebSession $smokeSession -TimeoutSec 8
$bootMatch = [Text.RegularExpressions.Regex]::Match(
  $homePage.Content,
  '(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*(?<graph>\{.*?\})\s*</script>',
  [Text.RegularExpressions.RegexOptions]::Singleline
)
if (-not $bootMatch.Success) { & taskkill /PID $smoke.Id /T /F | Out-Null; throw "Seed smoke homepage is missing the Harness boot manifest" }
$bootGraph = $bootMatch.Groups["graph"].Value | ConvertFrom-Json
$clientModules = '@deepseek-ai/dsh-client-modules'
if (-not @($bootGraph.entries | Where-Object { $_.id -eq $clientModules }).Count) {
  & taskkill /PID $smoke.Id /T /F | Out-Null
  throw "Seed smoke boot graph is missing $clientModules"
}
$bootstrapBatch = $bootGraph.batches | Where-Object {
  $_.phase -eq 'bootstrap' -and @($_.entries) -contains $clientModules
} | Select-Object -First 1
if (-not $bootstrapBatch -or [string]::IsNullOrWhiteSpace($bootstrapBatch.url)) {
  & taskkill /PID $smoke.Id /T /F | Out-Null
  throw "Seed smoke HTML did not preload $clientModules/client.js"
}
$bootstrapUrl = [Uri]::new([Uri]$readyUrl, [string]$bootstrapBatch.url).AbsoluteUri
$bootstrapResponse = Invoke-WebRequest -UseBasicParsing -Uri $bootstrapUrl -WebSession $smokeSession -TimeoutSec 8
if ($bootstrapResponse.StatusCode -ne 200 -or $bootstrapResponse.Content -notmatch [Text.RegularExpressions.Regex]::Escape($clientModules)) {
  & taskkill /PID $smoke.Id /T /F | Out-Null
  throw "Seed smoke client-modules bootstrap bundle failed validation"
}
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
$pluginVersion = Get-DesktopPluginVersion
$pluginPackages = @(
  @{ directory = "plugin-host"; name = "@run-bigpig/dsh-desktop-plugin-host"; source = "packages/plugin-host/package.json"; version = $pluginVersion },
  @{ directory = "plugin-client"; name = "@run-bigpig/dsh-desktop-plugin-client"; source = "packages/plugin-client/package.json"; version = $pluginVersion },
  @{ directory = "plugin-bundle"; name = "@run-bigpig/dsh-desktop-plugin"; source = "packages/plugin-bundle/package.json"; version = $pluginVersion }
)
foreach ($required in $pluginBuild,$marketplaceCatalog,$marketplaceSignature) {
  if (-not (Test-Path $required)) { throw "Built-in Desktop Plugin source is incomplete: $required" }
}
foreach ($package in $pluginPackages) {
  $manifestPath = Join-Path $pluginSource $package.source
  if (-not (Test-Path $manifestPath)) { throw "Built-in Desktop Plugin source is incomplete: $manifestPath" }
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.name -ne $package.name) { throw "Built-in Desktop Plugin package name mismatch: $manifestPath" }
  if ($manifest.version -ne $package.version) { throw "Built-in Desktop Plugin package version mismatch: $manifestPath" }
}
$designArchive = Join-Path $downloads ("starweave-ui-" + $designRelease.tag + ".tar.gz")
if ((Test-Path -LiteralPath $designArchive) -and (Get-SHA256File $designArchive) -ne $designRelease.archiveSHA256) {
  Remove-Item -LiteralPath $designArchive -Force
}
if (-not (Test-Path -LiteralPath $designArchive)) {
  Invoke-WebRequest -UseBasicParsing -Uri $designRelease.archiveURL -Headers $designReleaseHeaders -OutFile $designArchive
}
$designArchiveHash = Get-SHA256File $designArchive
if ($designArchiveHash -ne $designRelease.archiveSHA256) {
  throw "SHA-256 mismatch for StarWeave UI $($designRelease.tag): expected $($designRelease.archiveSHA256), got $designArchiveHash"
}
$designWeb = Join-Path $buildRoot "starweave-ui"
Remove-DirectoryTree $designWeb
New-Item -ItemType Directory -Force $designWeb | Out-Null
& tar.exe -xzf $designArchive -C $designWeb
if ($LASTEXITCODE -ne 0) { throw "Unable to extract StarWeave UI $($designRelease.tag)" }
foreach ($requiredDesignSource in "index.html","canvaskit.wasm","starweave-ui-build.json") {
  if (-not (Test-Path -LiteralPath (Join-Path $designWeb $requiredDesignSource))) {
    throw "StarWeave UI $($designRelease.tag) is missing $requiredDesignSource"
  }
}
$designBuild = Get-Content (Join-Path $designWeb "starweave-ui-build.json") -Raw | ConvertFrom-Json
if (
  $designBuild.schemaVersion -ne 1 -or
  $designBuild.tag -cne $designRelease.tag -or
  ("v" + [string]$designBuild.version) -cne $designRelease.tag -or
  $designBuild.commit -notmatch '^[0-9a-f]{40}$'
) {
  throw "StarWeave UI $($designRelease.tag) has an invalid build manifest"
}
& $node $pluginBuild --harness $checkout --out $pluginTarget --design-web $designWeb
if ($LASTEXITCODE -ne 0) { throw "Desktop Plugin build failed" }
foreach ($package in $pluginPackages) {
  $builtManifestPath = Join-Path $pluginTarget ($package.directory + "/package.json")
  if (-not (Test-Path $builtManifestPath)) { throw "Built-in Desktop Plugin package is missing: $builtManifestPath" }
  $builtManifestText = Get-Content $builtManifestPath -Raw
  $builtManifest = $builtManifestText | ConvertFrom-Json
  if ($builtManifest.name -ne $package.name -or $builtManifest.version -ne $package.version) {
    throw "Built-in Desktop Plugin package identity mismatch: $builtManifestPath"
  }
  if ($builtManifestText -match 'workspace:') { throw "Built-in Desktop Plugin contains an unpublished workspace dependency: $builtManifestPath" }
}
foreach ($requiredDesignFile in @(
  "plugin-host/lib/design.js",
  "plugin-host/web/starweave-ui/index.html",
  "plugin-host/web/starweave-ui/canvaskit.wasm",
  "plugin-host/web/starweave-ui/starweave-ui-build.json",
  "plugin-bundle/LICENSES/open-pencil-MIT.txt",
  "plugin-bundle/LICENSES/canvaskit-BSD-3-Clause.txt",
  "plugin-bundle/LICENSES/vue-MIT.txt",
  "plugin-bundle/LICENSES/yjs-MIT.txt"
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $pluginTarget $requiredDesignFile))) {
    throw "Built-in Desktop Plugin is missing StarWeave Design resource: $requiredDesignFile"
  }
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
$finalSeedFingerprint = Get-WindowsSeedFingerprint $repoRoot
if ($finalSeedFingerprint -ne $sourceSeedFingerprint) {
  throw "Seed or plugin sources changed during the Windows build; retry from a stable worktree"
}
Write-JsonAtomic -Path $seedManifestPath -Value ([ordered]@{
  schemaVersion = 2
  fingerprint = $seedFingerprint
  sourceFingerprint = $sourceSeedFingerprint
  commit = $seedLock.commit
  ref = $seedLock.ref
  node = $seedLock.node
  pnpm = $seedLock.pnpm
  pluginVersion = $pluginVersion
  designRelease = [ordered]@{
    repository = $designRelease.repository
    tag = $designRelease.tag
    sha256 = $designRelease.archiveSHA256
    commit = [string]$designBuild.commit
  }
  createdAtUTC = [DateTime]::UtcNow.ToString("o")
})

Publish-VerifiedSeedCache
$buildLock.Dispose()
Write-Host "Verified installable Harness workspace seed, source-built Desktop Plugin, and Marketplace catalog staged at $seedSourceTarget"
