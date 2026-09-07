param([string]$HarnessPath = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$buildRoot = Join-Path $repoRoot 'dist/windows/seed-build'
if (-not $HarnessPath) { $HarnessPath = Join-Path $buildRoot 'harness' }
$HarnessPath = (Resolve-Path $HarnessPath).Path
$node = Join-Path $buildRoot 'toolchain/node/node.exe'
$git = Join-Path $buildRoot 'toolchain/git/cmd/git.exe'
$lock = Get-Content (Join-Path $repoRoot 'release/seed.lock.json') -Raw | ConvertFrom-Json
$head = & $git -C $HarnessPath rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head.Trim() -ne $lock.commit) { throw 'Probe requires the locked Harness checkout. Run task seed:windows first.' }
$upstreamPaths = @('packages/client/ui-layout', 'packages/client/ui-chat', 'packages/client/ui-tool', 'packages/client/ui-trajectory', 'packages/client/ui-renderer', 'packages/client/ui-slots')
& $git -C $HarnessPath diff --exit-code HEAD -- @upstreamPaths
if ($LASTEXITCODE -ne 0) { throw 'Probe requires unmodified upstream UI modules.' }
# Use the existing package dependency layout without copying or reinstalling it.
# The probe imports official sources only; no stale Desktop overlay source executes.
$testRoot = Join-Path $HarnessPath 'packages/desktop/plugin-client/tests'
if (-not (Test-Path (Join-Path $testRoot '../node_modules/react/package.json'))) {
    throw 'Built Desktop plugin dependency layout is missing. Run task seed:windows first.'
}
$probeRoot = Join-Path $testRoot ('details-contract-probe-' + [guid]::NewGuid().ToString('N'))
$result = Join-Path $repoRoot 'dist/windows/details-contract-results.json'
try {
    New-Item -ItemType Directory -Path $probeRoot | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'details-contract.spec.tsx') (Join-Path $probeRoot 'details-contract.spec.tsx')
    if (Test-Path $result) { Remove-Item $result }
    Push-Location $HarnessPath
    try {
        & $node node_modules/vitest/vitest.mjs run $probeRoot `
            packages/client/ui-layout/tests/service.client.spec.ts `
            packages/client/ui-layout/tests/layout-store.client.spec.ts `
            packages/client/ui-layout/tests/app-frame.client.spec.tsx `
            packages/client/ui-chat/tests/apply-inject.client.spec.tsx `
            packages/client/ui-chat/tests/selection-survival.client.spec.tsx `
            --maxWorkers 2 --reporter default --reporter json --outputFile.json $result
        if ($LASTEXITCODE -ne 0) { throw "Details contract probe failed; see $result" }
    } finally { Pop-Location }
    & $git -C $HarnessPath diff --exit-code HEAD -- @upstreamPaths
    if ($LASTEXITCODE -ne 0) { throw 'Upstream UI modules changed during the probe.' }
    Write-Output "Harness commit: $head"
    Write-Output "Characterization results: $result (passing tests do not mean the product gate is satisfied)"
} finally {
    if (Test-Path $probeRoot) { Remove-Item -LiteralPath $probeRoot -Recurse -Force }
}
