Unicode true
RequestExecutionLevel user
Name "DeepSeek Harness Desktop"
OutFile "..\..\dist\windows\DeepSeek-Harness-Desktop-Setup-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\DeepSeek Harness Desktop"
InstallDirRegKey HKCU "Software\DeepSeekHarnessDesktop" "InstallDir"
SetCompressor /SOLID lzma

!ifndef APP_VERSION
!define APP_VERSION "0.2.1"
!endif

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "DeepSeek Harness Desktop"
VIAddVersionKey "FileDescription" "DeepSeek Harness Desktop Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "MIT"

!ifndef STAGE_DIR
!define STAGE_DIR "..\..\dist\windows\stage"
!endif

!include "MUI2.nsh"
!include "x64.nsh"
Var OldResourcesDir
Var CleanupProcessID
Var EmptyCleanupDir
Var CleanupScript
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\deepseek-harness-desktop.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  FindWindow $1 "" "DeepSeek Harness Desktop"
  ${If} $1 != 0
    IfSilent close_desktop
    MessageBox MB_YESNO|MB_ICONQUESTION "DeepSeek Harness Desktop 正在运行。是否关闭程序并继续安装？" IDYES close_desktop
    SetErrorLevel 2
    Abort
    close_desktop:
    IfFileExists "$INSTDIR\deepseek-harness-desktop.exe" 0 force_close_desktop
    Exec '"$INSTDIR\deepseek-harness-desktop.exe" --quit-for-update'
    StrCpy $2 0
    wait_for_desktop:
      Sleep 100
      FindWindow $1 "" "DeepSeek Harness Desktop"
      ${If} $1 == 0
        Goto desktop_closed
      ${EndIf}
      IntOp $2 $2 + 1
      IntCmp $2 50 force_close_desktop wait_for_desktop force_close_desktop
    force_close_desktop:
      ExecWait '"$SYSDIR\taskkill.exe" /IM deepseek-harness-desktop.exe /T /F' $0
      Sleep 300
      FindWindow $1 "" "DeepSeek Harness Desktop"
      ${If} $1 != 0
        IfSilent desktop_close_failed
        MessageBox MB_ICONSTOP "无法关闭 DeepSeek Harness Desktop。请稍后重试。"
        desktop_close_failed:
        SetErrorLevel 2
        Abort
      ${EndIf}
    desktop_closed:
      Sleep 1000
      ExecWait '"$SYSDIR\taskkill.exe" /IM deepseek-harness-desktop.exe /T /F' $0
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "DeepSeek Harness Desktop 首版仅支持 Windows x64。"
    Abort
  ${EndIf}
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F1E7EBA9-5A1D-45DA-9596-DBAB34A6F164}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F1E7EBA9-5A1D-45DA-9596-DBAB34A6F164}" "pv"
  ${EndIf}
  ${If} $0 == ""
    IfFileExists "$PROGRAMFILES32\Microsoft\EdgeWebView\Application\*.*" webview_found
    IfFileExists "$LOCALAPPDATA\Microsoft\EdgeWebView\Application\*.*" webview_found
    IfSilent webview_missing
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "未检测到 Microsoft Edge WebView2 Evergreen Runtime。是否打开官方下载安装页？安装 WebView2 后请重新运行本安装器。" IDNO +2
    ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/"
    webview_missing:
    Abort
  ${EndIf}
  webview_found:
FunctionEnd

Section "Install"
  StrCpy $OldResourcesDir ""
  IfFileExists "$INSTDIR\resources\*.*" 0 install_resources_detached
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  StrCpy $CleanupProcessID $0
  StrCpy $OldResourcesDir "$INSTDIR.resources-old-$CleanupProcessID"
  ClearErrors
  Rename "$INSTDIR\resources" "$OldResourcesDir"
  IfErrors install_resources_fallback install_resources_detached
  install_resources_fallback:
    StrCpy $OldResourcesDir ""
    RMDir /r "$INSTDIR\resources"
  install_resources_detached:
  CreateDirectory "$APPDATA\DeepSeekHarnessDesktop\logs"
  FileOpen $1 "$APPDATA\DeepSeekHarnessDesktop\logs\installer-cleanup.log" a
  FileWrite $1 "nsis install detached: old=$OldResourcesDir$\r$\n"
  FileClose $1
  StrCmp $OldResourcesDir "" install_cleanup_started
  StrCpy $EmptyCleanupDir "$TEMP\dsh-empty-$CleanupProcessID"
  StrCpy $CleanupScript "$TEMP\DeepSeekHarnessDesktop-cleanup-$CleanupProcessID.ps1"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=cleanup-resources.ps1 "${__FILEDIR__}\cleanup-resources.ps1"
  CopyFiles /SILENT "$PLUGINSDIR\cleanup-resources.ps1" "$CleanupScript"
  FileOpen $1 "$APPDATA\DeepSeekHarnessDesktop\logs\installer-cleanup.log" a
  FileWrite $1 "nsis install launcher: script=$CleanupScript$\r$\n"
  FileClose $1
  IfFileExists "$CleanupScript" 0 install_cleanup_fallback
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_OLD", t "$OldResourcesDir") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_EMPTY", t "$EmptyCleanupDir") i.r0'
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$CleanupScript"' $0
  FileOpen $1 "$APPDATA\DeepSeekHarnessDesktop\logs\installer-cleanup.log" a
  FileWrite $1 "nsis install launcher exit: code=$0$\r$\n"
  FileClose $1
  IntCmp $0 0 install_cleanup_started install_cleanup_fallback install_cleanup_fallback
  install_cleanup_fallback:
    Delete "$CleanupScript"
    RMDir /r "$OldResourcesDir"
    StrCpy $OldResourcesDir ""
  install_cleanup_started:
  Delete "$INSTDIR\deepseek-harness-desktop.exe"
  Delete "$INSTDIR\Uninstall.exe"
  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\DeepSeekHarnessDesktop" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekHarnessDesktop" "DisplayName" "DeepSeek Harness Desktop"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekHarnessDesktop" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekHarnessDesktop" "DisplayVersion" "${APP_VERSION}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekHarnessDesktop" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekHarnessDesktop" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\DeepSeek Harness Desktop"
  CreateShortcut "$SMPROGRAMS\DeepSeek Harness Desktop\DeepSeek Harness Desktop.lnk" "$INSTDIR\deepseek-harness-desktop.exe"
SectionEnd

Section "Uninstall"
  StrCpy $OldResourcesDir ""
  IfFileExists "$INSTDIR\resources\*.*" 0 uninstall_resources_detached
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  StrCpy $CleanupProcessID $0
  StrCpy $OldResourcesDir "$INSTDIR.resources-old-$CleanupProcessID"
  ClearErrors
  Rename "$INSTDIR\resources" "$OldResourcesDir"
  IfErrors uninstall_resources_fallback uninstall_resources_detached
  uninstall_resources_fallback:
    StrCpy $OldResourcesDir ""
    RMDir /r "$INSTDIR\resources"
  uninstall_resources_detached:
  StrCmp $OldResourcesDir "" uninstall_cleanup_started
  StrCpy $EmptyCleanupDir "$TEMP\dsh-empty-$CleanupProcessID"
  StrCpy $CleanupScript "$TEMP\DeepSeekHarnessDesktop-cleanup-$CleanupProcessID.ps1"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=cleanup-resources.ps1 "${__FILEDIR__}\cleanup-resources.ps1"
  CopyFiles /SILENT "$PLUGINSDIR\cleanup-resources.ps1" "$CleanupScript"
  IfFileExists "$CleanupScript" 0 uninstall_cleanup_fallback
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_OLD", t "$OldResourcesDir") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_EMPTY", t "$EmptyCleanupDir") i.r0'
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$CleanupScript"' $0
  IntCmp $0 0 uninstall_cleanup_started uninstall_cleanup_fallback uninstall_cleanup_fallback
  uninstall_cleanup_fallback:
    Delete "$CleanupScript"
    RMDir /r "$OldResourcesDir"
    StrCpy $OldResourcesDir ""
  uninstall_cleanup_started:
  Delete "$SMPROGRAMS\DeepSeek Harness Desktop\DeepSeek Harness Desktop.lnk"
  RMDir "$SMPROGRAMS\DeepSeek Harness Desktop"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekHarnessDesktop"
  DeleteRegKey HKCU "Software\DeepSeekHarnessDesktop"
  IfSilent uninstall_done
  MessageBox MB_OK "程序文件已移除。为避免意外数据丢失，Harness 私有数据和备份仍保留在用户配置目录。"
  uninstall_done:
SectionEnd
