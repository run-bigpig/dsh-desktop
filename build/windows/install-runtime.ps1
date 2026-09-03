$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$source = $env:DSH_DESKTOP_SOURCE_ROOT
$runtime = $env:DSH_DESKTOP_RUNTIME_ROOT
$pnpm = $env:DSH_DESKTOP_PNPM
$nodeDir = $env:DSH_DESKTOP_NODE_DIR
$materializer = $env:DSH_DESKTOP_MATERIALIZER
$store = $env:DSH_DESKTOP_PNPM_STORE
$pluginRoot = $env:DSH_DESKTOP_PLUGIN_ROOT
$logPath = $env:DSH_DESKTOP_INSTALL_LOG
$registry = $env:DSH_DESKTOP_REGISTRY
$officialRegistry = "https://registry.npmjs.org/"
$mirrorRegistry = "https://registry.npmmirror.com/"

foreach ($required in $source,$runtime,$pnpm,$nodeDir,$materializer,$store,$pluginRoot,$logPath,$registry) {
  if ([string]::IsNullOrWhiteSpace($required)) { throw "Runtime installer environment is incomplete" }
}
if ($registry -notin $officialRegistry,$mirrorRegistry) {
  throw "Unsupported dependency registry"
}
if (-not (Test-Path (Join-Path $source "apps/cli/lib/bin.js"))) { throw "Harness CLI entry is missing" }
if (-not (Test-Path (Join-Path $source "pnpm-lock.yaml"))) { throw "Harness lockfile is missing" }
if (-not (Test-Path $pnpm)) { throw "Embedded pnpm is missing" }
$node = Join-Path $nodeDir "node.exe"
if (-not (Test-Path $node)) { throw "Embedded Node is missing" }
if (-not (Test-Path $materializer)) { throw "Harness workspace materializer is missing" }
foreach ($directory in "plugin-host","plugin-client","plugin-bundle") {
  if (-not (Test-Path (Join-Path $pluginRoot ($directory + "\package.json")))) {
    throw "Built-in plugin package is missing: $directory"
  }
}

$logDir = Split-Path -Parent $logPath
$installerHome = Join-Path $env:APPDATA "StarWeave\installer-home"
New-Item -ItemType Directory -Force $logDir,$installerHome,$store | Out-Null
$env:HOME = $installerHome
$env:USERPROFILE = $installerHome
$env:CI = "1"
$env:GIT_TERMINAL_PROMPT = "0"
$env:PATH = @($nodeDir,(Join-Path $env:SystemRoot "System32")) -join ";"
Remove-Item Env:SSH_AUTH_SOCK -ErrorAction SilentlyContinue
Get-ChildItem Env: | Where-Object { $_.Name -match '(TOKEN|SECRET|PASSWORD|API_KEY|OPENAI|ANTHROPIC|DEEPSEEK)' } | ForEach-Object {
  Remove-Item ("Env:" + $_.Name) -ErrorAction SilentlyContinue
}

$script:pnpmExitCode = 0

function Invoke-PnpmLogged {
  param(
    [string]$Phase,
    [string]$RegistryURL,
    [string[]]$Arguments
  )

  $isMirror = $RegistryURL -eq $mirrorRegistry
  $sourceLabel = if ($isMirror) { "npmmirror registry" } else { "official npm registry" }
  $networkArguments = if ($isMirror) {
    @(
      "--fetch-retries", "1",
      "--fetch-retry-mintimeout", "3000",
      "--fetch-retry-maxtimeout", "15000",
      "--fetch-timeout", "60000"
    )
  } else {
    @(
      "--fetch-retries", "5",
      "--fetch-retry-mintimeout", "10000",
      "--fetch-retry-maxtimeout", "120000",
      "--fetch-timeout", "300000"
    )
  }
  $pnpmArguments = @("--registry", $RegistryURL) + $networkArguments + $Arguments
  Write-Output ("{0}: using {1}..." -f $Phase,$sourceLabel)
  Add-Content -LiteralPath $logPath -Value ("$Phase source: $RegistryURL")
  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $pnpm @pnpmArguments 2>&1 | Tee-Object -FilePath $logPath -Append
  $script:pnpmExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  Add-Content -LiteralPath $logPath -Value ("$Phase exit: $script:pnpmExitCode")
}

function Remove-PluginDependencySeed {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return }
  Add-Content -LiteralPath $logPath -Value ("built-in plugin dependency seed cleanup start: " + $Path)
  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })" $Path 2>&1 | Tee-Object -FilePath $logPath -Append
  $cleanupExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  if ($cleanupExitCode -ne 0 -or (Test-Path -LiteralPath $Path)) {
    Add-Content -LiteralPath $logPath -Value ("built-in plugin dependency seed cleanup deferred: " + $Path)
    Write-Warning "Temporary built-in plugin dependency files could not be removed; a later install will retry cleanup."
    return
  }
  Add-Content -LiteralPath $logPath -Value ("built-in plugin dependency seed cleanup complete: " + $Path)
}

function Remove-StalePluginDependencySeeds {
  Get-ChildItem -LiteralPath $installerHome -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "plugin-dependency-seed" -or $_.Name.StartsWith("plugin-dependency-seed-") } |
    ForEach-Object { Remove-PluginDependencySeed $_.FullName }
}

Add-Content -LiteralPath $logPath -Value ("dependency install start: " + [DateTime]::UtcNow.ToString("O"))
$runtimeParent = Split-Path -Parent $runtime
New-Item -ItemType Directory -Force $runtimeParent | Out-Null
if (Test-Path $runtime) {
  & $node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })" $runtime
  if ($LASTEXITCODE -ne 0 -or (Test-Path $runtime)) { throw "Unable to clear incomplete Harness runtime" }
}
$deploy = Join-Path $runtime "apps/cli"
$arguments = @(
  "--config.inject-workspace-packages=true",
  "--config.node-linker=hoisted",
  "--config.strict-dep-builds=false",
  "--store-dir", $store,
  "--dir", $source,
  "--filter", "@deepseek-ai/dsh",
  "--prod",
  "--frozen-lockfile",
  "--network-concurrency", "8",
  "deploy", $deploy
)

Invoke-PnpmLogged "Harness dependency install" $registry $arguments
$exitCode = $script:pnpmExitCode
if ($exitCode -ne 0 -and $registry -eq $mirrorRegistry) {
  Write-Output "The npmmirror registry failed; retrying with the official npm registry..."
  Add-Content -LiteralPath $logPath -Value "dependency install fallback: mirror -> official"
  if (Test-Path $runtime) {
    & $node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })" $runtime
    if ($LASTEXITCODE -ne 0 -or (Test-Path $runtime)) { throw "Unable to clear failed mirror runtime" }
  }
  Invoke-PnpmLogged "Harness dependency install" $officialRegistry $arguments
  $exitCode = $script:pnpmExitCode
  $registry = $officialRegistry
}
if ($exitCode -ne 0) { exit $exitCode }

$savedErrorPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $node $materializer $source $deploy 2>&1 | Tee-Object -FilePath $logPath -Append
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $savedErrorPreference
Add-Content -LiteralPath $logPath -Value ("workspace materialization exit: " + $exitCode)
if ($exitCode -ne 0) { exit $exitCode }

if (-not (Test-Path (Join-Path $deploy "lib/bin.js"))) { throw "Harness deploy did not create the CLI entry" }
if (-not (Test-Path (Join-Path $deploy "node_modules"))) { throw "Harness deploy did not create node_modules" }

$pluginDependencies = [ordered]@{}
foreach ($directory in "plugin-host","plugin-client","plugin-bundle") {
  $manifest = Get-Content (Join-Path $pluginRoot ($directory + "\package.json")) -Raw | ConvertFrom-Json
  $dependenciesProperty = $manifest.PSObject.Properties["dependencies"]
  if ($null -eq $dependenciesProperty) { continue }
  foreach ($dependency in $dependenciesProperty.Value.PSObject.Properties) {
    if ($dependency.Value -isnot [string] -or $dependency.Value.StartsWith("workspace:")) {
      throw "Built-in plugin dependency is not installable: $($dependency.Name)"
    }
    if ($pluginDependencies.Contains($dependency.Name) -and $pluginDependencies[$dependency.Name] -ne $dependency.Value) {
      throw "Built-in plugin dependency versions conflict: $($dependency.Name)"
    }
    $pluginDependencies[$dependency.Name] = $dependency.Value
  }
}

if ($pluginDependencies.Count -gt 0) {
  Remove-StalePluginDependencySeeds
  $dependencySeed = Join-Path $installerHome ("plugin-dependency-seed-" + [Guid]::NewGuid().ToString("N"))
  $seedExitCode = 1
  try {
    New-Item -ItemType Directory -Force $dependencySeed | Out-Null
    [ordered]@{
      name = "starweave-plugin-dependency-seed"
      version = "0.0.0"
      private = $true
      dependencies = $pluginDependencies
    } | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $dependencySeed "package.json")

    Add-Content -LiteralPath $logPath -Value ("built-in plugin dependency seed start: " + [DateTime]::UtcNow.ToString("O"))
    $seedArguments = @(
      "--store-dir", $store,
      "--dir", $dependencySeed,
      "--ignore-scripts",
      "--lockfile=false",
      "--prefer-offline",
      "install"
    )
    Invoke-PnpmLogged "Built-in plugin dependency install" $registry $seedArguments
    $seedExitCode = $script:pnpmExitCode
    if ($seedExitCode -ne 0 -and $registry -eq $mirrorRegistry) {
      Write-Output "The npmmirror registry failed for built-in plugin dependencies; retrying with the official npm registry..."
      Add-Content -LiteralPath $logPath -Value "built-in plugin dependency fallback: mirror -> official"
      $dependencyNodeModules = Join-Path $dependencySeed "node_modules"
      if (Test-Path $dependencyNodeModules) {
        & $node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })" $dependencyNodeModules
      }
      Invoke-PnpmLogged "Built-in plugin dependency install" $officialRegistry $seedArguments
      $seedExitCode = $script:pnpmExitCode
    }
  } finally {
    Remove-PluginDependencySeed $dependencySeed
  }
  Add-Content -LiteralPath $logPath -Value ("built-in plugin dependency seed exit: " + $seedExitCode)
  if ($seedExitCode -ne 0) { exit $seedExitCode }
}
exit 0
