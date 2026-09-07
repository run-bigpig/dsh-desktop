param([switch]$KeepOpen)
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$probe = Join-Path $repo 'dist/windows/browser-probe'
$manifest = Join-Path $probe 'manifest.json'
$sdk = Join-Path $probe 'sdk'
# Test-only SDK, never staged or loaded by the product. Verify before extraction.
$version = '1.0.4191.47'
$sdkHash = 'f492bbf547d0da329553b6727435b677579b1e9f91cc9e4a1ad029366d5f23d0'
New-Item -ItemType Directory -Force $probe | Out-Null
$archive = Join-Path $probe "microsoft.web.webview2.$version.zip"
if (-not (Test-Path $archive)) {
    Invoke-WebRequest -UseBasicParsing "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -OutFile $archive
}
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sdkHash) { throw 'WebView2 probe SDK checksum mismatch' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    New-Item -ItemType Directory -Force $sdk | Out-Null
    foreach ($entry in @('build/native/include/WebView2.h','build/native/x64/WebView2Loader.dll')) {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry($entry), (Join-Path $sdk (Split-Path $entry -Leaf)), $true)
    }
} finally { $zip.Dispose() }

function Command($body) {
    $json = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 8 -Compress))
    $response = Invoke-RestMethod -Uri ($script:connection.url + '/command') -Method Post -Headers @{Authorization='Bearer '+$script:connection.token} -ContentType 'application/json; charset=utf-8' -Body $json -TimeoutSec 30
    if ($response.error) { throw $response.error }
    return $response.value
}
if (Test-Path $manifest) {
    throw 'A probe manifest exists. Close that probe through its authenticated /command endpoint before rerunning.'
}
Push-Location $repo
try {
    & gofmt -w internal/plugin/testdata/browser-workspace/main_windows.go
    if ($LASTEXITCODE -ne 0) { throw 'gofmt failed' }
    & go build -tags production -ldflags '-H windowsgui' -o (Join-Path $probe 'browser-workspace.exe') ./internal/plugin/testdata/browser-workspace
    if ($LASTEXITCODE -ne 0) { throw 'Browser probe build failed' }
} finally { Pop-Location }

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BrowserProbeNative {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
    public static bool Activate(IntPtr window) {
        uint current=GetCurrentThreadId(), foreground=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
        bool attached=current!=foreground && AttachThreadInput(current,foreground,true);
        try { BringWindowToTop(window);SetForegroundWindow(window);return GetForegroundWindow()==window; }
        finally { if(attached) AttachThreadInput(current,foreground,false); }
    }
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
}
'@
$script:checks = [Collections.Generic.List[object]]::new()
function Check($name, $condition, $evidence) {
    $script:checks.Add([ordered]@{name=$name;passed=[bool]$condition;evidence=$evidence})
    Write-Output "$name : $condition ($evidence)"
}
function Evaluate($tab, $expression) { return ((Command @{op='eval';tab=$tab;script=$expression}) | ConvertFrom-Json) }
function Activate-Probe {
    if (-not [BrowserProbeNative]::Activate($script:hwnd)) {
        throw 'Probe window cannot acquire foreground focus; native input verification needs an unlocked interactive Windows desktop.'
    }
    Start-Sleep -Milliseconds 150
}
function Capture($name) {
    Activate-Probe
    $origin = New-Object BrowserProbeNative+Point
    $rect = New-Object BrowserProbeNative+Rect
    [BrowserProbeNative]::ClientToScreen($script:hwnd,[ref]$origin) | Out-Null
    [BrowserProbeNative]::GetClientRect($script:hwnd,[ref]$rect) | Out-Null
    $bitmap = New-Object Drawing.Bitmap($rect.Right,$rect.Bottom)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($origin.X,$origin.Y,0,0,$bitmap.Size)
        $bitmap.Save((Join-Path $probe "$name.png"))
        return $bitmap.GetPixel(1000,550).ToArgb()
    } finally { $graphics.Dispose();$bitmap.Dispose() }
}

$process = Start-Process -FilePath (Join-Path $probe 'browser-workspace.exe') -ArgumentList ('"'+$sdk+'"'),('"'+$manifest+'"') -RedirectStandardOutput (Join-Path $probe 'stdout.log') -RedirectStandardError (Join-Path $probe 'stderr.log') -PassThru
try {
    for ($attempt=0;$attempt -lt 100 -and -not (Test-Path $manifest);$attempt++) {
        if ($process.HasExited) { throw 'Browser probe exited before readiness; inspect stderr.log' }
        Start-Sleep -Milliseconds 100
    }
    $script:connection = Get-Content $manifest -Raw | ConvertFrom-Json
    $ready = Command @{op='ready'}
    $script:hwnd = [IntPtr]$ready.hwnd
    Activate-Probe
    Check 'Native environment and public Wails HWND' ($ready.runtime -and $ready.hwnd) $ready.runtime
    $bounds = @{Left=620;Top=90;Right=1120;Bottom=650}
    foreach ($t in @(@('a1','session-a'),@('a2','session-a'),@('b1','session-b'))) {
        Command @{op='create';tab=$t[0];profile=$t[1];bounds=$bounds} | Out-Null
        $loaded=$false
        for ($attempt=0;$attempt -lt 60;$attempt++) {
            if ((Evaluate $t[0] 'document.readyState === "complete" && !!document.querySelector("#input")')) { $loaded=$true;break }
            Start-Sleep -Milliseconds 100
        }
        if (-not $loaded) { throw "Page $($t[0]) failed to load" }
    }
    Evaluate 'a1' 'document.cookie="session=alpha;path=/;SameSite=Strict;Max-Age=3600";localStorage.setItem("session","alpha");true' | Out-Null
    Check 'Same session tabs share cookies and storage' (Evaluate 'a2' 'document.cookie.includes("session=alpha") && localStorage.getItem("session")==="alpha"') 'a1 -> a2'
    Check 'Different session profile isolates cookies and storage' (Evaluate 'b1' '!document.cookie && localStorage.getItem("session")===null') 'a1 -> b1'
    Evaluate 'b1' 'document.cookie="session=beta;path=/;SameSite=Strict;Max-Age=3600";localStorage.setItem("session","beta");true' | Out-Null
    Check 'Other session writes preserve original session' (Evaluate 'a1' 'document.cookie.includes("session=alpha") && localStorage.getItem("session")==="alpha"') 'b1 -> a1'
    $settings=Command @{op='settings';tab='a1'}
    $noBindings=Evaluate 'a1' 'typeof window._wails==="undefined" && typeof window.wails==="undefined"'
    Check 'Untrusted page has no Wails bindings; host channels disabled' ($noBindings -and $settings.messages -eq 0 -and $settings.hostObjects -eq 0 -and $settings.devtools -eq 0) ($settings | ConvertTo-Json -Compress)
    Command @{op='visible';tab='a1';visible=$true} | Out-Null
    Start-Sleep -Milliseconds 300
    $browserPixel=Capture 'browser-visible'
    Check 'Native browser is painted inside sidebar bounds' ($browserPixel -eq [Drawing.Color]::FromArgb(0,180,220).ToArgb()) $browserPixel
    Command @{op='visible';tab='a1';visible=$false} | Out-Null
    Check 'Hidden page remains operable by Agent' (Evaluate 'a1' 'document.querySelector("button").click();window.clicks===1') 'ExecuteScript on hidden controller'
    Command @{op='visible';tab='b1';visible=$true} | Out-Null
    Check 'Background result stays in its own session' (Evaluate 'b1' 'window.clicks===0') 'a1 hidden click does not affect b1'
    Command @{op='visible';tab='b1';visible=$false} | Out-Null
    Command @{op='visible';tab='a1';visible=$true} | Out-Null
    Activate-Probe
    Command @{op='focus';tab='a1'} | Out-Null
    Evaluate 'a1' 'document.querySelector("input").focus();true' | Out-Null
    Add-Type -AssemblyName System.Windows.Forms
    $inputRect=Evaluate 'a1' 'JSON.stringify(document.querySelector("input").getBoundingClientRect().toJSON())' | ConvertFrom-Json
    $origin=New-Object BrowserProbeNative+Point
    [BrowserProbeNative]::ClientToScreen($script:hwnd,[ref]$origin) | Out-Null
    [BrowserProbeNative]::SetCursorPos(($origin.X+620+$inputRect.x+25),($origin.Y+90+$inputRect.y+10)) | Out-Null
    [BrowserProbeNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    [BrowserProbeNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
    if ([BrowserProbeNative]::GetForegroundWindow() -ne $script:hwnd) { throw 'Probe lost foreground focus before keyboard input; no keys sent.' }
    [Windows.Forms.SendKeys]::SendWait('native-input')
    Start-Sleep -Milliseconds 150
    Check 'Native keyboard focus and input' (Evaluate 'a1' 'document.querySelector("input").value==="native-input" && inputs.length>0') (Evaluate 'a1' 'JSON.stringify({focus:document.hasFocus(),active:document.activeElement.id,value:document.querySelector("input").value,inputs})')
    Evaluate 'a1' 'document.querySelector("input").select();true' | Out-Null
    Command @{op='cdp';tab='a1';method='Input.insertText';params=@{text=[string][char]0x4E2D+[string][char]0x6587}} | Out-Null
    Start-Sleep -Milliseconds 100
    Check 'Agent CDP edits the same user page with Unicode text' (Evaluate 'a1' 'document.querySelector("input").value==="\u4e2d\u6587"') 'CDP replaces the selected native input with Chinese text'
    Command @{op='visible';tab='a1';visible=$false} | Out-Null
    Command @{op='park';tab='a1'} | Out-Null
    $shot=(Command @{op='cdp';tab='a1';method='Page.captureScreenshot';params=@{format='png'}})|ConvertFrom-Json
    Check 'Hidden browser supports Agent screenshot' ($shot.data.Length -gt 100) 'Page.captureScreenshot on hidden controller'
    Command @{op='visible';tab='a1';visible=$true} | Out-Null
    Command @{op='resize';bounds=@{Right=1320;Bottom=900}} | Out-Null
    Command @{op='bounds';tab='a1';bounds=@{Left=620;Top=90;Right=1240;Bottom=720}} | Out-Null
    Start-Sleep -Milliseconds 200
    $viewport=Evaluate 'a1' 'JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})' | ConvertFrom-Json
    Check 'Window and sidebar resizing update native viewport' ($viewport.width*$viewport.dpr -eq 620 -and $viewport.height*$viewport.dpr -eq 630) ($viewport|ConvertTo-Json -Compress)
    Command @{op='resize';bounds=@{Right=1200;Bottom=800}} | Out-Null
    Command @{op='bounds';tab='a1';bounds=$bounds} | Out-Null
    Command @{op='minimize'} | Out-Null
    Check 'Minimized page remains operable' (Evaluate 'a1' 'window.clicks===1') 'Minimize -> ExecuteScript'
    Command @{op='restore'} | Out-Null
    Command @{op='hide'} | Out-Null
    Check 'Tray-style hidden window retains page' (Evaluate 'a1' 'document.cookie.includes("session=alpha")') 'Hide -> ExecuteScript'
    Command @{op='show'} | Out-Null
    [BrowserProbeNative]::SetForegroundWindow($script:hwnd) | Out-Null
    # Real DOM top-layer dialog: a stronger overlay than Harness body portals.
    Command @{op='modal';visible=$true} | Out-Null
    Start-Sleep -Milliseconds 400
    $dialogPixel=Capture 'modal-with-native-browser'
    # Accepted product behavior: native views require explicit occlusion coordination.
    Check 'Native airspace limitation is reproduced' ($dialogPixel -eq [Drawing.Color]::FromArgb(0,180,220).ToArgb()) "sidebar pixel=$dialogPixel"
    Command @{op='visible';tab='a1';visible=$false} | Out-Null
    Start-Sleep -Milliseconds 250
    $hiddenPixel=Capture 'modal-with-browser-hidden'
    Check 'Explicit native hide restores modal visibility' ($hiddenPixel -eq [Drawing.Color]::FromArgb(255,0,180).ToArgb()) "sidebar pixel=$hiddenPixel"
    Command @{op='modal';visible=$false} | Out-Null
    Command @{op='visible';tab='a1';visible=$true} | Out-Null
    Check 'Hiding for modal preserves page and login' (Evaluate 'a1' 'window.clicks===1 && document.cookie.includes("session=alpha")') 'Hide/show controller'
    foreach ($tab in @('a1','a2')) { Command @{op='close';tab=$tab} | Out-Null }
    Command @{op='create';tab='a3';profile='session-a';bounds=$bounds} | Out-Null
    for ($attempt=0;$attempt -lt 60;$attempt++) {
        if ((Evaluate 'a3' 'document.readyState==="complete" && !!document.querySelector("#input")')) {break}
        Start-Sleep -Milliseconds 100
    }
    Check 'Recreated controller restores profile login' (Evaluate 'a3' 'document.cookie.includes("session=alpha") && localStorage.getItem("session")==="alpha"') 'Close all a tabs -> new a3'
    $report=[ordered]@{runtime=$ready.runtime;dpi=[BrowserProbeNative]::GetDpiForWindow($script:hwnd);sdk=$version;sdkSHA256=$sdkHash;checks=$script:checks;notValidated=@('Real Chinese IME composition','Cross-monitor DPI change','Harness modal/menu lifecycle coordination','Full Agent browser tool integration')}
    $report | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 (Join-Path $probe 'results.json')
} finally {
    if (-not $KeepOpen) {
        if ($script:connection) { Command @{op='quit'} | Out-Null }
        if (-not $process.WaitForExit(15000)) { throw 'Probe did not exit cleanly' }
        if ($ready.data) {
            $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
            $profile=[IO.Path]::GetFullPath($ready.data)
            if (-not $profile.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $profile -Leaf) -notlike 'starweave-browser-gate-*') { throw 'Refusing unexpected probe cleanup target' }
            for ($attempt=0;$attempt -lt 50 -and (Test-Path $profile);$attempt++) {
                try { Remove-Item -LiteralPath $profile -Recurse -Force } catch { Start-Sleep -Milliseconds 200 }
            }
            if (Test-Path $profile) { throw "Probe profile cleanup failed: $profile" }
            Write-Output 'Probe process exited; disposable profiles removed.'
        }
    }
}
if ($script:checks.Where({-not $_.passed}).Count -gt 0) { exit 2 }
