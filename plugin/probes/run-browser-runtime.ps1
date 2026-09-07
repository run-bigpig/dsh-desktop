$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$probe = Join-Path $repo 'dist/windows/browser-runtime-probe'
& (Join-Path $repo 'scripts/prepare-browser-runtime.ps1') -Stage $probe
$manifest = Join-Path $probe 'manifest.json'
Remove-Item -LiteralPath $manifest -Force -ErrorAction SilentlyContinue
Push-Location $repo
try {
  & gofmt -w internal/plugin/testdata/browser-runtime
  & go build -ldflags '-H windowsgui' -o (Join-Path $probe 'browser-runtime.exe') ./internal/plugin/testdata/browser-runtime
  if ($LASTEXITCODE -ne 0) { throw 'Product browser probe build failed' }
} finally { Pop-Location }
$process = Start-Process -FilePath (Join-Path $probe 'browser-runtime.exe') -ArgumentList @(('"'+(Join-Path $probe 'resources/browser/WebView2Loader.dll')+'"'),('"'+$manifest+'"')) -PassThru -RedirectStandardError (Join-Path $probe 'stderr.log') -RedirectStandardOutput (Join-Path $probe 'stdout.log')
$checks = [Collections.Generic.List[string]]::new()
function Command($body) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 12 -Compress))
  return Invoke-RestMethod -Uri ($script:connection.url+'v1/browser/command') -Method Post -Headers @{Authorization='Bearer '+$script:connection.token} -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30
}
function Eval($session,$tab,$script) {
  $result = Command @{op='cdp';sessionId=$session;tabId=$tab;method='Runtime.evaluate';params=@{expression=$script;returnByValue=$true;awaitPromise=$true}}
  if ($result.exceptionDetails) { throw ($result.exceptionDetails | ConvertTo-Json -Depth 8) }
  return $result.result.value
}
function Check($ok,$name) { if (-not $ok) { throw "Failed: $name" }; $checks.Add($name);Write-Output "PASS $name" }
try {
  for ($i=0;$i -lt 100 -and -not (Test-Path $manifest);$i++) { Start-Sleep -Milliseconds 100 }
  $script:connection = Get-Content $manifest -Raw | ConvertFrom-Json
  Command @{op='create';sessionId='a';tabId='one';url=$connection.page} | Out-Null
  Command @{op='create';sessionId='a';tabId='two';url=$connection.page} | Out-Null
  Command @{op='create';sessionId='b';tabId='one';url=$connection.page} | Out-Null
  for ($i=0;$i -lt 50;$i++) { if ((Eval 'a' 'one' 'document.readyState === "complete" && location.pathname === "/page"') -eq $true) { break };Start-Sleep -Milliseconds 100 }
  Eval 'a' 'one' 'document.cookie="owner=a;path=/;max-age=3600";localStorage.setItem("owner","a")' | Out-Null
  Check ((Eval 'a' 'two' 'localStorage.getItem("owner")') -eq 'a') 'same-session tabs share Profile'
  Check ($null -eq (Eval 'b' 'one' 'localStorage.getItem("owner")')) 'different sessions isolate Profile'
  Check ((Eval 'a' 'one' 'typeof window.wails') -eq 'undefined') 'untrusted page has no Wails runtime'
  Command @{op='layout';sessionId='a';tabId='one';visible=$true;sequence=1;bounds=@{x=500;y=80;width=600;height=550;scale=1}} | Out-Null
  Eval 'a' 'one' 'document.querySelector("input").focus()' | Out-Null
  $chinese = [string][char]0x4e2d + [char]0x6587
  Command @{op='cdp';sessionId='a';tabId='one';method='Input.insertText';params=@{text=$chinese}} | Out-Null
  Check ((Eval 'a' 'one' 'document.querySelector("input").value') -eq $chinese) 'CDP Unicode input reaches native page'
  Command @{op='layout';sessionId='a';tabId='one';visible=$false;sequence=2} | Out-Null
  $shot = Command @{op='cdp';sessionId='a';tabId='one';method='Page.captureScreenshot';params=@{format='png'}}
  Check ($shot.data.Length -gt 100) 'parked product view supports screenshot'
  [IO.File]::WriteAllBytes((Join-Path $probe 'background.png'),[Convert]::FromBase64String($shot.data))
  Eval 'b' 'one' 'localStorage.setItem("owner","b")' | Out-Null
  Check ((Eval 'a' 'one' 'localStorage.getItem("owner")') -eq 'a') 'background writes preserve foreground Profile'
  $denied = $false
  try { Command @{op='cdp';sessionId='a';tabId='one';method='Browser.close';params=@{}} | Out-Null } catch { $denied = $true }
  Check $denied 'browser-level CDP escape is rejected'
  $denied = $false
  try { Command @{op='navigate';sessionId='a';tabId='one';url='file:///C:/Windows/win.ini'} | Out-Null } catch { $denied = $true }
  Check $denied 'file navigation is rejected'
  Command @{op='list';sessionId='a'} | Out-Null
  Invoke-RestMethod ($connection.control+'/reset') -Method Post -Headers @{Authorization='Bearer '+$connection.token} | Out-Null
  $restored = Command @{op='list';sessionId='a'}
  Write-Output ('Restored tabs: ' + ($restored | ConvertTo-Json -Depth 6 -Compress))
  Check ($restored.Count -eq 2) 'desktop restart restores session tabs'
  for ($i=0;$i -lt 50;$i++) { if ((Eval 'a' 'one' 'document.readyState === "complete" && location.pathname === "/page"') -eq $true) { break };Start-Sleep -Milliseconds 100 }
  Check ((Eval 'a' 'one' 'document.cookie.includes("owner=a")') -eq $true) 'persistent Profile restores login after controller recreation'
  Command @{op='remove-session';sessionId='a'} | Out-Null
  Check ((Command @{op='list';sessionId='a'}).Count -eq 0) 'deleted session releases tabs'
  $checks | ConvertTo-Json | Set-Content (Join-Path $probe 'results.json') -Encoding UTF8
} catch { Write-Output ("Probe error: " + $_.Exception.Message); throw } finally {
  if ($connection) { try { Invoke-RestMethod ($connection.control+'/quit') -Method Post -Headers @{Authorization='Bearer '+$connection.token} | Out-Null } catch {} }
  if (-not $process.WaitForExit(10000)) { $process.Kill();$process.WaitForExit() }
  if ($connection -and (Split-Path $connection.root -Leaf).StartsWith('starweave-browser-runtime-')) {
    for ($retry=0;$retry -lt 20;$retry++) {
      try { Remove-Item -LiteralPath $connection.root -Recurse -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 250 }
    }
  }
}
