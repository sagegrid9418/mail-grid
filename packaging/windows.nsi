Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
Var MailGridUpdating
Var MailGridForceRun
Var MailGridWaitCount

Name "Mail Grid"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Mail Grid"
InstallDirRegKey HKCU "Software\MailGrid" "InstallLocation"
RequestExecutionLevel user
; Streaming zlib keeps cross-platform beta rebuilds practical.
SetCompressor zlib
SetDatablockOptimize on
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "Mail Grid"
VIAddVersionKey "FileDescription" "Mail Grid local email installer"
VIAddVersionKey "CompanyName" "Mail Grid contributors"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Mail Grid contributors"

!define MUI_ABORTWARNING
!define MUI_CUSTOMFUNCTION_ABORT MailGridUserAbort
!define MUI_FINISHPAGE_RUN "$INSTDIR\mail-grid.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Mail Grid"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!macro CheckMailGridClosed
  FindWindow $0 "Chrome_WidgetWin_1" "Mail Grid"
  StrCmp $0 0 +3
    MessageBox MB_OK|MB_ICONEXCLAMATION "Quit Mail Grid from its tray menu before installing or uninstalling. Your saved mail will be kept."
    Abort
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "This installer requires 64-bit Windows."
    Abort
  ${EndIf}
  SetShellVarContext current
  StrCpy $MailGridUpdating "0"
  StrCpy $MailGridForceRun "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--updated" $1
  ${IfNot} ${Errors}
    StrCpy $MailGridUpdating "1"
    SetSilent silent
    StrCpy $MailGridWaitCount 0
    wait_for_parent:
      FindWindow $0 "Chrome_WidgetWin_1" "Mail Grid"
      ${If} $0 != 0
        IntOp $MailGridWaitCount $MailGridWaitCount + 1
        ${If} $MailGridWaitCount > 150
          Abort "Mail Grid did not close. No files were replaced."
        ${EndIf}
        Sleep 200
        Goto wait_for_parent
      ${EndIf}
  ${EndIf}
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--force-run" $1
  ${IfNot} ${Errors}
    StrCpy $MailGridForceRun "1"
  ${EndIf}
  !insertmacro CheckMailGridClosed
FunctionEnd

Function un.onInit
  SetShellVarContext current
  !insertmacro CheckMailGridClosed
FunctionEnd

Section "Mail Grid (required)" Application
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${APP_DIRECTORY}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Mail Grid.exe"
  CreateShortcut "$SMPROGRAMS\Mail Grid.lnk" "$INSTDIR\mail-grid.exe"
  WinShell::SetLnkAUMI "$SMPROGRAMS\Mail Grid.lnk" "dev.mailgrid.app"
  WriteRegStr HKCU "Software\MailGrid" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid" "DisplayName" "Mail Grid"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid" "Publisher" "Mail Grid contributors"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid" "DisplayIcon" "$INSTDIR\mail-grid.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid" "UninstallString" '$\"$INSTDIR\Uninstall Mail Grid.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid" "EstimatedSize" ${INSTALLED_KB}
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid" "NoRepair" 1
SectionEnd

Section /o "Desktop shortcut" DesktopShortcut
  CreateShortcut "$DESKTOP\Mail Grid.lnk" "$INSTDIR\mail-grid.exe"
  WinShell::SetLnkAUMI "$DESKTOP\Mail Grid.lnk" "dev.mailgrid.app"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Mail Grid.lnk"
  Delete "$SMPROGRAMS\Mail Grid.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mail Grid"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid"
  DeleteRegKey HKCU "Software\MailGrid"
  ; The generated list deletes installed files only, preserving unrelated files and user mail.
  !include "${UNINSTALL_INCLUDE}"
  Delete "$INSTDIR\Uninstall Mail Grid.exe"
  RMDir "$INSTDIR"
SectionEnd

Function .onInstSuccess
  ${If} $MailGridForceRun == "1"
    Exec '"$INSTDIR\mail-grid.exe"'
  ${EndIf}
FunctionEnd
Function .onInstFailed
  ${If} $MailGridUpdating == "1"
    Exec '"$INSTDIR\mail-grid.exe"'
  ${EndIf}
FunctionEnd
Function MailGridUserAbort
  ${If} $MailGridUpdating == "1"
    Exec '"$INSTDIR\mail-grid.exe"'
  ${EndIf}
FunctionEnd
