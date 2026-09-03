function Get-SHA256Text([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-SHA256File([string]$Path) {
  $stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($Path))
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-SourceFingerprint {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string[]]$Paths,
    [string[]]$ExcludePatterns = @()
  )

  $root = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
  $files = [Collections.Generic.List[IO.FileInfo]]::new()
  foreach ($inputPath in $Paths) {
    $resolved = if ([IO.Path]::IsPathRooted($inputPath)) { $inputPath } else { Join-Path $root $inputPath }
    if (-not (Test-Path -LiteralPath $resolved)) { throw "Fingerprint input is missing: $resolved" }
    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.PSIsContainer) {
      $pending = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
      $pending.Push($item)
      while ($pending.Count -gt 0) {
        foreach ($child in Get-ChildItem -LiteralPath $pending.Pop().FullName -Force) {
          $relative = $child.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
          $excluded = $false
          foreach ($pattern in $ExcludePatterns) {
            if ($relative -match $pattern) { $excluded = $true; break }
          }
          if ($excluded) { continue }
          if ($child.PSIsContainer) {
            if (-not ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $pending.Push($child) }
          } else {
            $files.Add($child)
          }
        }
      }
    } else {
      $files.Add($item)
    }
  }

  $entries = foreach ($file in $files) {
    $relative = $file.FullName.Substring($root.Length).TrimStart('\').Replace('\', '/')
    $hash = Get-SHA256File $file.FullName
    $relative + "`t" + $hash
  }
  return (Get-SHA256Text ((@($entries) | Sort-Object) -join "`n"))
}

function Get-WindowsSeedFingerprint([string]$RepoRoot) {
  return (Get-SourceFingerprint -RepoRoot $RepoRoot -Paths @(
    "release/seed.lock.json",
    "release/toolchain.lock.json",
    "scripts/prepare-windows-seed.ps1",
    "scripts/stage-workspace-runtime.mjs",
    "scripts/materialize-workspace-runtime.mjs",
    "scripts/windows-build-common.ps1",
    "internal/desktop/child-control.mjs",
    "plugin/scripts/build-against-harness.mjs",
    "plugin/catalog",
    "plugin/packages"
  ) -ExcludePatterns @(
    '(^|/)(node_modules|lib|dist)(/|$)',
    '(^|/)tests?(/|$)'
  ))
}

function Get-WindowsDesktopFingerprint {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$ReleaseAPI
  )
  $source = Get-SourceFingerprint -RepoRoot $RepoRoot -Paths @(
    "assets.go",
    "go.mod",
    "go.sum",
    "cmd",
    "internal",
    "frontend",
    "build/appicon.png",
    "build/windows/app.manifest",
    "build/windows/icon.ico",
    "build/windows/icon.svg",
    "build/windows/info.json"
  ) -ExcludePatterns @(
    '_test\.go$',
    '\.syso$'
  )
  return (Get-SHA256Text ("source=$source`nversion=$Version`nreleaseAPI=$ReleaseAPI"))
}

function Write-JsonAtomic {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force $parent | Out-Null
  $temporary = $Path + ".tmp-" + [Guid]::NewGuid().ToString("N")
  $Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Remove-DirectoryTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $parent = Split-Path -Parent $Path
  $detached = Join-Path $parent ((Split-Path -Leaf $Path) + "-stale-" + [Guid]::NewGuid().ToString("N"))
  Move-Item -LiteralPath $Path -Destination $detached
  Remove-DetachedDirectoryTree $detached
}

function Remove-DetachedDirectoryTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $slash = [IO.Path]::DirectorySeparatorChar
  $longPath = [string]$slash + [string]$slash + '?' + [string]$slash + $Path
  & cmd.exe /d /c rmdir /s /q $longPath
  if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $Path)) {
    throw "Unable to remove generated directory: $Path"
  }
}

function Copy-DirectoryTree {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  if (-not (Test-Path -LiteralPath $Source)) { throw "Generated directory is missing: $Source" }
  New-Item -ItemType Directory -Force $Destination | Out-Null
  & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP /NJH /NJS
  if ($LASTEXITCODE -ge 8) { throw "Unable to copy generated directory from $Source to $Destination (robocopy exit code $LASTEXITCODE)" }
}

function Enter-WindowsBuildLock([string]$RepoRoot) {
  $lockRoot = Join-Path $RepoRoot "dist/windows/locks"
  New-Item -ItemType Directory -Force $lockRoot | Out-Null
  $lockPath = Join-Path $lockRoot "release.lock"
  try {
    return [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    throw "Another Windows build or packaging operation is already running: $lockPath"
  }
}
