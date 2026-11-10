; Loaded by customHeader after electron-builder defines CHECK_APP_RUNNING.
; Calling one function avoids redeclaring its global variables at every hook.
Var CmdPath
Var PowerShellPath
!macroundef CHECK_APP_RUNNING
!macro CHECK_APP_RUNNING
  Call L2SoloCheckRunningAndAccess
!macroend
