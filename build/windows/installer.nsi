Unicode true
RequestExecutionLevel user
Name "StarWeave"
Caption "StarWeave 安装"
!ifndef INSTALLER_OUTPUT
!define INSTALLER_OUTPUT "../../dist/windows/StarWeaveInstaller.exe"
!endif
OutFile "${INSTALLER_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\StarWeave"
InstallDirRegKey HKCU "Software\StarWeave" "InstallDir"
SetCompressor /SOLID lzma

!ifndef APP_VERSION
!define APP_VERSION "0.2.1"
!endif

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "StarWeave"
VIAddVersionKey "FileDescription" "StarWeave Installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "MIT"

!ifndef STAGE_DIR
!define STAGE_DIR "..\..\dist\windows\stage"
!endif
!ifndef SEED_COMMIT
!error "SEED_COMMIT must be provided by the packaging script"
!endif

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "x64.nsh"
!ifndef PBS_MARQUEE
!define PBS_MARQUEE 0x00000008
!endif
!ifndef PBM_SETPOS
!define PBM_SETPOS 0x0402
!endif
!ifndef PBM_SETMARQUEE
!define PBM_SETMARQUEE 0x040A
!endif
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
Var OldResourcesDir
Var CleanupProcessID
Var EmptyCleanupDir
Var CleanupScript
Var LegacyInstallDir
Var LegacyInstallMoved
Var LegacyDataDir
Var ActiveDataDir
Var PreviousExecutableName
Var FailedResourcesDir
Var RegistryURL
Var OfficialRegistryRadio
Var ChinaRegistryRadio
Var InstallProgressBar
Var InstallProgressStyle
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page Custom RegistryPageCreate RegistryPageLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\StarWeave.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function FindRunningDesktopWindow
  FindWindow $1 "WailsWebviewWindow" "StarWeave"
  ${If} $1 == 0
    FindWindow $1 "WailsWebviewWindow" "DSH-DeskTop"
    ${If} $1 == 0
      FindWindow $1 "WailsWebviewWindow" "DeepSeek Harness Desktop"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function .onInit
  StrCpy $RegistryURL "https://registry.npmjs.org/"
  ReadRegStr $LegacyInstallDir HKCU "Software\DSH-DeskTop" "InstallDir"
  ${If} $LegacyInstallDir != ""
    IfFileExists "$LegacyInstallDir\*.*" legacy_dsh_registry_valid 0
    StrCpy $LegacyInstallDir ""
    legacy_dsh_registry_valid:
  ${EndIf}
  ${If} $LegacyInstallDir == ""
    ReadRegStr $LegacyInstallDir HKCU "Software\DeepSeekHarnessDesktop" "InstallDir"
  ${EndIf}
  ${If} $LegacyInstallDir != ""
    IfFileExists "$LegacyInstallDir\*.*" legacy_deepseek_registry_valid 0
    StrCpy $LegacyInstallDir ""
    legacy_deepseek_registry_valid:
  ${EndIf}
  ${If} $LegacyInstallDir == ""
    IfFileExists "$LOCALAPPDATA\Programs\DSH-DeskTop\*.*" 0 legacy_default_dsh_missing
    StrCpy $LegacyInstallDir "$LOCALAPPDATA\Programs\DSH-DeskTop"
    legacy_default_dsh_missing:
  ${EndIf}
  ${If} $LegacyInstallDir == ""
    IfFileExists "$LOCALAPPDATA\Programs\DeepSeek Harness Desktop\*.*" 0 legacy_default_deepseek_missing
    StrCpy $LegacyInstallDir "$LOCALAPPDATA\Programs\DeepSeek Harness Desktop"
    legacy_default_deepseek_missing:
  ${EndIf}
  Call FindRunningDesktopWindow
  ${If} $1 != 0
    IfSilent close_desktop
    MessageBox MB_YESNO|MB_ICONQUESTION "StarWeave 正在运行。是否关闭程序并继续安装？" IDYES close_desktop
    SetErrorLevel 2
    Abort
    close_desktop:
    StrCpy $2 0
    IfFileExists "$INSTDIR\StarWeave.exe" 0 close_legacy_desktop
    Exec '"$INSTDIR\StarWeave.exe" --quit-for-update'
    Goto wait_for_desktop
    close_legacy_desktop:
    IfFileExists "$LegacyInstallDir\dsh-desktop.exe" 0 close_deepseek_desktop
    Exec '"$LegacyInstallDir\dsh-desktop.exe" --quit-for-update'
    Goto wait_for_desktop
    close_deepseek_desktop:
    IfFileExists "$LegacyInstallDir\deepseek-harness-desktop.exe" 0 force_close_desktop
    Exec '"$LegacyInstallDir\deepseek-harness-desktop.exe" --quit-for-update'
    wait_for_desktop:
      Sleep 100
      Call FindRunningDesktopWindow
      ${If} $1 == 0
        Goto desktop_closed
      ${EndIf}
      IntOp $2 $2 + 1
      IntCmp $2 50 force_close_desktop wait_for_desktop force_close_desktop
    force_close_desktop:
      nsExec::Exec '"$SYSDIR\taskkill.exe" /IM StarWeave.exe /T /F'
      Pop $0
      nsExec::Exec '"$SYSDIR\taskkill.exe" /IM dsh-desktop.exe /T /F'
      Pop $0
      nsExec::Exec '"$SYSDIR\taskkill.exe" /IM deepseek-harness-desktop.exe /T /F'
      Pop $0
      Sleep 300
      Call FindRunningDesktopWindow
      ${If} $1 != 0
        IfSilent desktop_close_failed
        MessageBox MB_ICONSTOP "无法关闭 StarWeave。请稍后重试。"
        desktop_close_failed:
        SetErrorLevel 2
        Abort
      ${EndIf}
    desktop_closed:
      Sleep 1000
      nsExec::Exec '"$SYSDIR\taskkill.exe" /IM StarWeave.exe /T /F'
      Pop $0
      nsExec::Exec '"$SYSDIR\taskkill.exe" /IM dsh-desktop.exe /T /F'
      Pop $0
      nsExec::Exec '"$SYSDIR\taskkill.exe" /IM deepseek-harness-desktop.exe /T /F'
      Pop $0
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "StarWeave 首版仅支持 Windows x64。"
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

Function RegistryPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "请选择 Harness 依赖下载源。该选择仅用于本次安装，不会修改系统 npm 或 pnpm 配置。"
  Pop $0
  ${NSD_CreateRadioButton} 0 34u 100% 14u "官方 npm 源（registry.npmjs.org）"
  Pop $OfficialRegistryRadio
  ${NSD_CreateRadioButton} 0 56u 100% 14u "国内镜像（registry.npmmirror.com，失败时自动切换官方源）"
  Pop $ChinaRegistryRadio

  StrCmp $RegistryURL "https://registry.npmmirror.com/" 0 registry_select_official
  ${NSD_Check} $ChinaRegistryRadio
  Goto registry_page_ready
  registry_select_official:
  ${NSD_Check} $OfficialRegistryRadio
  registry_page_ready:
  nsDialogs::Show
FunctionEnd

Function BeginDependencyProgress
  GetDlgItem $InstallProgressBar $HWNDPARENT 1004
  StrCmp $InstallProgressBar 0 dependency_progress_begin_done
  System::Call 'user32::GetWindowLongW(i $InstallProgressBar, i ${GWL_STYLE}) i .r0'
  StrCpy $InstallProgressStyle $0
  IntOp $0 $0 | ${PBS_MARQUEE}
  System::Call 'user32::SetWindowLongW(i $InstallProgressBar, i ${GWL_STYLE}, i r0)'
  SendMessage $InstallProgressBar ${PBM_SETMARQUEE} 1 45
  dependency_progress_begin_done:
FunctionEnd

Function EndDependencyProgress
  StrCmp $InstallProgressBar 0 dependency_progress_end_done
  SendMessage $InstallProgressBar ${PBM_SETMARQUEE} 0 0
  System::Call 'user32::SetWindowLongW(i $InstallProgressBar, i ${GWL_STYLE}, i $InstallProgressStyle)'
  SendMessage $InstallProgressBar ${PBM_SETPOS} 100 0
  dependency_progress_end_done:
FunctionEnd

Function RegistryPageLeave
  ${NSD_GetState} $ChinaRegistryRadio $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $RegistryURL "https://registry.npmmirror.com/"
  ${Else}
    StrCpy $RegistryURL "https://registry.npmjs.org/"
  ${EndIf}
FunctionEnd

Section "Install"
  StrCpy $ActiveDataDir "StarWeave"
  StrCpy $LegacyDataDir ""
  IfFileExists "$APPDATA\StarWeave\*.*" data_migration_done
  IfFileExists "$APPDATA\DSH-DeskTop\*.*" 0 migrate_deepseek_data
  ClearErrors
  Rename "$APPDATA\DSH-DeskTop" "$APPDATA\StarWeave"
  IfErrors data_migration_failed
  StrCpy $LegacyDataDir "DSH-DeskTop"
  Goto data_migration_done
  migrate_deepseek_data:
  IfFileExists "$APPDATA\DeepSeekHarnessDesktop\*.*" 0 data_migration_done
  ClearErrors
  Rename "$APPDATA\DeepSeekHarnessDesktop" "$APPDATA\StarWeave"
  IfErrors data_migration_failed
  StrCpy $LegacyDataDir "DeepSeekHarnessDesktop"
  Goto data_migration_done
  data_migration_failed:
    MessageBox MB_ICONSTOP "无法将现有私有数据目录重命名为 StarWeave，安装已取消。"
    SetErrorLevel 3
    Abort
  data_migration_done:
  StrCpy $LegacyInstallMoved ""
  StrCmp $LegacyInstallDir "" legacy_install_removed
  StrCmp $LegacyInstallDir "$INSTDIR" legacy_install_removed
  IfFileExists "$LegacyInstallDir\*.*" 0 legacy_install_removed
  IfFileExists "$INSTDIR\*.*" legacy_install_destination_exists 0
  ClearErrors
  Rename "$LegacyInstallDir" "$INSTDIR"
  IfErrors legacy_install_move_failed
  StrCpy $LegacyInstallMoved "1"
  Goto legacy_install_removed
  legacy_install_destination_exists:
    StrCmp $LegacyDataDir "" +2
    Rename "$APPDATA\StarWeave" "$APPDATA\$LegacyDataDir"
    MessageBox MB_ICONSTOP "StarWeave 安装目录已存在，无法直接重命名旧安装目录。请先移走该目录后重试。"
    SetErrorLevel 3
    Abort
  legacy_install_move_failed:
    StrCmp $LegacyDataDir "" +2
    Rename "$APPDATA\StarWeave" "$APPDATA\$LegacyDataDir"
    MessageBox MB_ICONSTOP "无法将现有安装目录重命名为 StarWeave，安装已取消。请确认程序已完全退出后重试。"
    SetErrorLevel 3
    Abort
  legacy_install_removed:
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  StrCpy $CleanupProcessID $0
  StrCpy $OldResourcesDir ""
  IfFileExists "$INSTDIR\resources\*.*" 0 install_resources_detached
  StrCpy $OldResourcesDir "$INSTDIR.resources-old-$CleanupProcessID"
  IfFileExists "$OldResourcesDir\*.*" install_backup_failed 0
  ClearErrors
  Rename "$INSTDIR\resources" "$OldResourcesDir"
  IfErrors install_backup_failed install_resources_detached
  install_resources_detached:
  CreateDirectory "$APPDATA\StarWeave\logs"
  FileOpen $1 "$APPDATA\StarWeave\logs\installer-cleanup.log" a
  FileWrite $1 "nsis install detached: old=$OldResourcesDir$\r$\n"
  FileClose $1
  StrCpy $PreviousExecutableName ""
  Delete "$INSTDIR\StarWeave.exe.previous"
  IfFileExists "$INSTDIR\StarWeave.exe" backup_starweave_executable 0
  IfFileExists "$INSTDIR\dsh-desktop.exe" backup_dsh_executable 0
  IfFileExists "$INSTDIR\deepseek-harness-desktop.exe" backup_deepseek_executable install_executable_detached
  backup_starweave_executable:
  StrCpy $PreviousExecutableName "StarWeave.exe"
  Goto backup_existing_executable
  backup_dsh_executable:
  StrCpy $PreviousExecutableName "dsh-desktop.exe"
  Goto backup_existing_executable
  backup_deepseek_executable:
  StrCpy $PreviousExecutableName "deepseek-harness-desktop.exe"
  backup_existing_executable:
  ClearErrors
  Rename "$INSTDIR\$PreviousExecutableName" "$INSTDIR\StarWeave.exe.previous"
  IfErrors install_executable_backup_failed install_executable_detached
  install_executable_backup_failed:
    StrCmp $OldResourcesDir "" install_backup_failed
    Rename "$OldResourcesDir" "$INSTDIR\resources"
  install_backup_failed:
    StrCmp $LegacyInstallMoved "1" 0 +2
    Rename "$INSTDIR" "$LegacyInstallDir"
    StrCmp $LegacyDataDir "" +2
    Rename "$APPDATA\StarWeave" "$APPDATA\$LegacyDataDir"
    IfSilent +2
    MessageBox MB_ICONSTOP "无法安全备份当前安装，安装已取消。请确认 StarWeave 已完全退出后重试。"
    SetErrorLevel 3
    Abort
  install_executable_detached:
  SetOutPath "$INSTDIR"
  File /r /x "desktop-build.json" /x "build-manifest.json" "${STAGE_DIR}\*"
  DetailPrint "正在安装 Harness 运行依赖..."
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=install-runtime.ps1 "install-runtime.ps1"
  File /oname=materialize-workspace-runtime.mjs "..\..\scripts\materialize-workspace-runtime.mjs"
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_SOURCE_ROOT", t "$INSTDIR\resources\seed\source\${SEED_COMMIT}") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_RUNTIME_ROOT", t "$INSTDIR\resources\seed\runtime\${SEED_COMMIT}") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_PNPM", t "$INSTDIR\resources\toolchain\pnpm\pnpm.exe") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_NODE_DIR", t "$INSTDIR\resources\toolchain\node") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_MATERIALIZER", t "$PLUGINSDIR\materialize-workspace-runtime.mjs") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_PNPM_STORE", t "$APPDATA\StarWeave\pnpm-store") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_PLUGIN_ROOT", t "$INSTDIR\resources\plugin") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_INSTALL_LOG", t "$APPDATA\StarWeave\logs\installer-dependencies.log") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_REGISTRY", t "$RegistryURL") i.r0'
  Call BeginDependencyProgress
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\install-runtime.ps1"'
  Pop $0
  Call EndDependencyProgress
  StrCmp $0 "0" install_dependencies_ready install_dependencies_failed
  install_dependencies_failed:
    DetailPrint "Harness 运行依赖安装失败，正在恢复原版本..."
    StrCpy $FailedResourcesDir "$INSTDIR.resources-failed-$CleanupProcessID"
    Rename "$INSTDIR\resources" "$FailedResourcesDir"
    StrCmp $OldResourcesDir "" +2
    Rename "$OldResourcesDir" "$INSTDIR\resources"
    Delete "$INSTDIR\StarWeave.exe"
    StrCmp $PreviousExecutableName "" +2
    Rename "$INSTDIR\StarWeave.exe.previous" "$INSTDIR\$PreviousExecutableName"
    StrCmp $LegacyInstallMoved "1" 0 +2
    Rename "$INSTDIR" "$LegacyInstallDir"
    StrCmp $LegacyDataDir "" install_failure_data_ready
    Rename "$APPDATA\StarWeave" "$APPDATA\$LegacyDataDir"
    StrCpy $ActiveDataDir $LegacyDataDir
    install_failure_data_ready:
    StrCpy $EmptyCleanupDir "$TEMP\dsh-empty-failed-$CleanupProcessID"
    StrCpy $CleanupScript "$TEMP\StarWeave-cleanup-failed-$CleanupProcessID.ps1"
    File /oname=cleanup-resources-failed.ps1 "cleanup-resources.ps1"
    CopyFiles /SILENT "$PLUGINSDIR\cleanup-resources-failed.ps1" "$CleanupScript"
    System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_OLD", t "$FailedResourcesDir") i.r0'
    System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_EMPTY", t "$EmptyCleanupDir") i.r0'
    System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_LOG_DIR", t "$APPDATA\$ActiveDataDir\logs") i.r0'
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$CleanupScript"'
    Pop $1
    IfSilent +2
    MessageBox MB_ICONSTOP "Harness 运行依赖安装失败。请检查网络后重试。详细日志：$APPDATA\$ActiveDataDir\logs\installer-dependencies.log"
    SetErrorLevel 3
    Abort
  install_dependencies_ready:
  DetailPrint "Harness 运行依赖安装完成。"
  Delete "$INSTDIR\StarWeave.exe.previous"
  Delete "$INSTDIR\dsh-desktop.exe"
  Delete "$INSTDIR\deepseek-harness-desktop.exe"
  Delete "$INSTDIR\Uninstall.exe"
  StrCmp $OldResourcesDir "" install_cleanup_started
  StrCpy $EmptyCleanupDir "$TEMP\dsh-empty-$CleanupProcessID"
  StrCpy $CleanupScript "$TEMP\StarWeave-cleanup-$CleanupProcessID.ps1"
  File /oname=cleanup-resources.ps1 "cleanup-resources.ps1"
  CopyFiles /SILENT "$PLUGINSDIR\cleanup-resources.ps1" "$CleanupScript"
  FileOpen $1 "$APPDATA\StarWeave\logs\installer-cleanup.log" a
  FileWrite $1 "nsis install launcher: script=$CleanupScript$\r$\n"
  FileClose $1
  IfFileExists "$CleanupScript" 0 install_cleanup_fallback
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_OLD", t "$OldResourcesDir") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_EMPTY", t "$EmptyCleanupDir") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_LOG_DIR", t "$APPDATA\StarWeave\logs") i.r0'
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$CleanupScript"'
  Pop $0
  FileOpen $1 "$APPDATA\StarWeave\logs\installer-cleanup.log" a
  FileWrite $1 "nsis install launcher exit: code=$0$\r$\n"
  FileClose $1
  IntCmp $0 0 install_cleanup_started install_cleanup_fallback install_cleanup_fallback
  install_cleanup_fallback:
    Delete "$CleanupScript"
    RMDir /r "$OldResourcesDir"
    StrCpy $OldResourcesDir ""
  install_cleanup_started:
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\StarWeave" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarWeave" "DisplayName" "StarWeave"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarWeave" "DisplayIcon" '"$INSTDIR\StarWeave.exe",0'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarWeave" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarWeave" "DisplayVersion" "${APP_VERSION}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarWeave" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarWeave" "NoRepair" 1
  Delete "$SMPROGRAMS\DeepSeek Harness Desktop\DeepSeek Harness Desktop.lnk"
  RMDir "$SMPROGRAMS\DeepSeek Harness Desktop"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekHarnessDesktop"
  DeleteRegKey HKCU "Software\DeepSeekHarnessDesktop"
  Delete "$SMPROGRAMS\DSH-DeskTop\DSH-DeskTop.lnk"
  RMDir "$SMPROGRAMS\DSH-DeskTop"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH-DeskTop"
  DeleteRegKey HKCU "Software\DSH-DeskTop"
  CreateDirectory "$SMPROGRAMS\StarWeave"
  CreateShortcut "$SMPROGRAMS\StarWeave\StarWeave.lnk" "$INSTDIR\StarWeave.exe"
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
  StrCpy $CleanupScript "$TEMP\StarWeave-cleanup-$CleanupProcessID.ps1"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=cleanup-resources.ps1 "cleanup-resources.ps1"
  CopyFiles /SILENT "$PLUGINSDIR\cleanup-resources.ps1" "$CleanupScript"
  IfFileExists "$CleanupScript" 0 uninstall_cleanup_fallback
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_OLD", t "$OldResourcesDir") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_EMPTY", t "$EmptyCleanupDir") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_DESKTOP_CLEAN_LOG_DIR", t "$APPDATA\StarWeave\logs") i.r0'
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$CleanupScript"'
  Pop $0
  IntCmp $0 0 uninstall_cleanup_started uninstall_cleanup_fallback uninstall_cleanup_fallback
  uninstall_cleanup_fallback:
    Delete "$CleanupScript"
    RMDir /r "$OldResourcesDir"
    StrCpy $OldResourcesDir ""
  uninstall_cleanup_started:
  Delete "$SMPROGRAMS\StarWeave\StarWeave.lnk"
  RMDir "$SMPROGRAMS\StarWeave"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarWeave"
  DeleteRegKey HKCU "Software\StarWeave"
  IfSilent uninstall_done
  MessageBox MB_OK "程序文件已移除。为避免意外数据丢失，Harness 私有数据和备份仍保留在用户配置目录。"
  uninstall_done:
SectionEnd
