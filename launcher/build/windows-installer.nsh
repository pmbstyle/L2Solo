!include UAC.nsh
!include getProcessInfo.nsh
Var pid
!addincludedir "${__FILEDIR__}"
!include "windows-messages.nsh"

; The standard running-app check remains in use for both install and uninstall.
; The installer additionally checks access before uninstallOldVersion is reached.
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    Call L2SoloCheckInstallAccess
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!include "windows-preflight.nsh"
Var L2SoloElevationRequested
Var L2SoloPermissionResume
Var L2SoloOriginalProfile
Var L2SoloPreviousDirectory

; A permission elevation resumes the chosen installation, skipping the directory
; page just as --updated does. The normal installer and uninstaller flags remain.
!macroundef _isUpdated
!macro _isUpdated _a _b _t _f
  StrCmp $L2SoloPermissionResume "1" `${_t}`
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp $R9 "true" `${_t}` `${_f}`
!macroend

!macro customInit
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_GetGlobal $L2SoloPermissionResume $L2SoloElevationRequested
    ${If} $L2SoloPermissionResume == "1"
      Call L2SoloRestoreInstallContext
    ${EndIf}
  ${EndIf}
  ; Silent installers do not run the progress-page callback.
  ${If} ${Silent}
    !insertmacro CHECK_APP_RUNNING
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE L2SoloBeforeInstall
!macroend

!macro customHeader
!insertmacro L2SoloInstallerMessages
!include "windows-check-hook.nsh"
Function L2SoloCheckRunningAndAccess
  StrCpy $CmdPath "$SYSDIR\cmd.exe"
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  Call L2SoloCheckInstallAccess
FunctionEnd

Function L2SoloRestoreInstallContext
  !insertmacro UAC_AsUser_GetGlobal $INSTDIR $INSTDIR
  !insertmacro UAC_AsUser_GetGlobal $installMode $installMode
  !insertmacro UAC_AsUser_GetGlobal $L2SoloOriginalProfile $PROFILE
  ${If} $installMode == "all"
    !ifndef INSTALL_MODE_PER_ALL_USERS
      !ifndef ONE_CLICK
        StrCpy $hasPerMachineInstallation "1"
        StrCpy $hasPerUserInstallation "0"
      !endif
    !endif
    SetShellVarContext all
  ${Else}
    ; Using another account's HKCU would register the update for the wrong user.
    ${If} $PROFILE != $L2SoloOriginalProfile
      MessageBox MB_OK|MB_ICONSTOP "This installation belongs to another Windows account. Use administrator privileges for the same account, or choose a location writable by that account. The previous installation has not been removed." /SD IDOK
      SetErrorLevel 5
      Quit
    ${EndIf}
    !ifndef INSTALL_MODE_PER_ALL_USERS
      !ifndef ONE_CLICK
        StrCpy $hasPerMachineInstallation "0"
        StrCpy $hasPerUserInstallation "1"
      !endif
    !endif
    SetShellVarContext current
  ${EndIf}
FunctionEnd

Function L2SoloBeforeInstall
  ${If} $L2SoloPermissionResume == "1"
    ; The stock UAC install-mode page assumes elevation means an all-users
    ; installation. Restore the actual selection before any file changes.
    Call L2SoloRestoreInstallContext
  ${Else}
    !ifdef allowToChangeInstallationDirectory
      Call instFilesPre
    !endif
  ${EndIf}
  !insertmacro CHECK_APP_RUNNING
FunctionEnd

Function L2SoloCheckInstallAccess
  ; SetOutPath in the stock onInit can leave our own current directory locked.
  ; The install section selects INSTDIR again before extracting the payload.
  SetOutPath "$TEMP"
  StrCpy $L2SoloAccessError 0
  StrCpy $L2SoloAccessPath $INSTDIR
  ClearErrors
  CreateDirectory "$INSTDIR"
  ${If} ${Errors}
    System::Call 'kernel32::GetLastError() i.s'
    Pop $L2SoloAccessError
    ${If} $L2SoloAccessError == 0
      StrCpy $L2SoloAccessError 5
    ${EndIf}
  ${Else}
    Push $INSTDIR
    Call L2SoloProbeDirectory
  ${EndIf}
  ${If} $L2SoloAccessError == 0
    ; A changed destination can still uninstall a version in another folder.
    ReadRegStr $L2SoloPreviousDirectory SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $L2SoloPreviousDirectory != ""
    ${AndIf} $L2SoloPreviousDirectory != $INSTDIR
    ${AndIf} ${FileExists} "$L2SoloPreviousDirectory\*.*"
      Push $L2SoloPreviousDirectory
      Call L2SoloProbeDirectory
    ${EndIf}
  ${EndIf}
  ${If} $L2SoloAccessError == 0
  ${AndIf} $installMode == "all"
    ReadRegStr $L2SoloPreviousDirectory HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $L2SoloPreviousDirectory != ""
    ${AndIf} $L2SoloPreviousDirectory != $INSTDIR
    ${AndIf} ${FileExists} "$L2SoloPreviousDirectory\*.*"
      Push $L2SoloPreviousDirectory
      Call L2SoloProbeDirectory
    ${EndIf}
  ${EndIf}
  ${If} $L2SoloAccessError == 0
    ClearErrors
    Return
  ${EndIf}

  ${If} $L2SoloAccessError == 5
  ${OrIf} $L2SoloAccessError == 1314
    ${IfNot} ${UAC_IsAdmin}
      StrCpy $L2SoloElevationRequested "1"
      ShowWindow $HWNDPARENT ${SW_HIDE}
      !insertmacro UAC_RunElevated
      ${If} $0 == 0
      ${AndIf} $1 == 1
        SetErrorLevel $2
        Quit
      ${EndIf}
      ShowWindow $HWNDPARENT ${SW_SHOW}
      ${If} $0 == 1223
        MessageBox MB_OK|MB_ICONEXCLAMATION "Administrator permission was not granted. The previous installation has not been removed." /SD IDOK
        SetErrorLevel 1223
        Quit
      ${EndIf}
      ${If} $0 == 0
      ${AndIf} $1 == 3
        MessageBox MB_OK|MB_ICONSTOP "The selected account does not have administrator permission. The previous installation has not been removed." /SD IDOK
        SetErrorLevel 740
        Quit
      ${EndIf}
      MessageBox MB_OK|MB_ICONSTOP "Setup could not obtain administrator permission (Windows error $0). The previous installation has not been removed. Run Setup as administrator or choose a writable installation folder." /SD IDOK
      SetErrorLevel 5
      Quit
    ${EndIf}
    MessageBox MB_OK|MB_ICONSTOP "Setup cannot modify this path, even with administrator permission:$\r$\n$L2SoloAccessPath$\r$\n$\r$\nCheck its permissions and read-only attributes, or choose another folder. The previous installation has not been removed. Windows error: $L2SoloAccessError." /SD IDOK
  ${ElseIf} $L2SoloAccessError == 32
  ${OrIf} $L2SoloAccessError == 33
    MessageBox MB_OK|MB_ICONSTOP "A file is still in use:$\r$\n$L2SoloAccessPath$\r$\n$\r$\nClose applications using this folder and run Setup again. The previous installation has not been removed." /SD IDOK
  ${ElseIf} $L2SoloAccessError == 60001
    MessageBox MB_OK|MB_ICONSTOP "A read-only file prevents installation:$\r$\n$L2SoloAccessPath$\r$\n$\r$\nRemove its read-only attribute and run Setup again. The previous installation has not been removed." /SD IDOK
  ${ElseIf} $L2SoloAccessError == 60002
    MessageBox MB_OK|MB_ICONSTOP "Setup cannot safely check a linked file or folder:$\r$\n$L2SoloAccessPath$\r$\n$\r$\nChoose an installation folder without symbolic links or junctions. The previous installation has not been removed." /SD IDOK
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "Setup cannot prepare this path:$\r$\n$L2SoloAccessPath$\r$\n$\r$\nCheck that the drive is available and has free space. The previous installation has not been removed. Windows error: $L2SoloAccessError." /SD IDOK
  ${EndIf}
  SetErrorLevel $L2SoloAccessError
  Quit
FunctionEnd
!macroend
!else
!macro customHeader
  !insertmacro L2SoloInstallerMessages
!macroend
!endif
