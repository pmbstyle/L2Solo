!ifndef L2SOLO_WINDOWS_PREFLIGHT
!define L2SOLO_WINDOWS_PREFLIGHT
!include LogicLib.nsh

Var L2SoloAccessError
Var L2SoloAccessPath

; Check actual create/write/delete access, not just file attributes or ACL names.
; Existing files are opened without truncation and never written to.
Function L2SoloProbeDirectory
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5

  StrCpy $L2SoloAccessPath $0
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r3 ?e'
  Pop $4
  ${If} $3 == -1
    Goto probeFailed
  ${EndIf}
  IntOp $5 $3 & 0x400
  ${If} $5 != 0
    StrCpy $4 60002
    Goto probeFailed
  ${EndIf}
  ; Removing the old version also needs delete access to its directories.
  System::Call 'kernel32::CreateFileW(w r0, i 0x10000, i 7, p 0, i 3, i 0x02000000, p 0) p.r3 ?e'
  Pop $4
  ${If} $3 == -1
    Goto probeFailed
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r3)'
  ClearErrors
  GetTempFileName $1 "$0"
  ${If} ${Errors}
    System::Call 'kernel32::GetLastError() i.r4'
    Goto probeFailed
  ${EndIf}
  ClearErrors
  FileOpen $3 "$1" w
  ${IfNot} ${Errors}
    FileWrite $3 "1"
    FileClose $3
  ${EndIf}
  ${If} ${Errors}
    System::Call 'kernel32::GetLastError() i.r4'
    Delete "$1"
    Goto probeFailed
  ${EndIf}
  System::Call 'kernel32::DeleteFileW(w r1) i.r3 ?e'
  Pop $4
  ${If} $3 == 0
    Goto probeFailed
  ${EndIf}

  FindFirst $1 $2 "$0\*"
  ${If} ${Errors}
    System::Call 'kernel32::GetLastError() i.r4'
    ${If} $4 != 2
    ${AndIf} $4 != 18
      Goto probeFailed
    ${EndIf}
  ${EndIf}
  probeNext:
    ${If} $2 == ""
      Goto probeDone
    ${EndIf}
    ${If} $2 == "."
    ${OrIf} $2 == ".."
      Goto probeContinue
    ${EndIf}
    StrCpy $L2SoloAccessPath "$0\$2"
    System::Call 'kernel32::GetFileAttributesW(w "$0\$2") i.r3 ?e'
    Pop $4
    ${If} $3 == -1
      Goto probeEntryFailed
    ${EndIf}
    IntOp $5 $3 & 0x400 ; FILE_ATTRIBUTE_REPARSE_POINT
    ${If} $5 != 0
      StrCpy $4 60002 ; Reparse points are not followed during the access check.
      Goto probeEntryFailed
    ${EndIf}
    IntOp $5 $3 & 0x10 ; FILE_ATTRIBUTE_DIRECTORY
    ${If} $5 != 0
      Push "$0\$2"
      Call L2SoloProbeDirectory
      ${If} $L2SoloAccessError != 0
        Goto probeDone
      ${EndIf}
    ${Else}
      IntOp $5 $3 & 1 ; FILE_ATTRIBUTE_READONLY cannot be fixed by UAC.
      ${If} $5 != 0
        StrCpy $4 60001
        Goto probeEntryFailed
      ${EndIf}
      ; GENERIC_WRITE | DELETE, FILE_SHARE_READ | WRITE | DELETE, OPEN_EXISTING.
      System::Call 'kernel32::CreateFileW(w "$0\$2", i 0x40010000, i 7, p 0, i 3, i 0, p 0) p.r3 ?e'
      Pop $4
      ${If} $3 == -1
        Goto probeEntryFailed
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p r3)'
    ${EndIf}
  probeContinue:
    FindNext $1 $2
    Goto probeNext
  probeEntryFailed:
    StrCpy $L2SoloAccessError $4
    ${If} $L2SoloAccessError == 0
      StrCpy $L2SoloAccessError 5
    ${EndIf}
  probeDone:
    FindClose $1
    Goto probeReturn
  probeFailed:
    StrCpy $L2SoloAccessError $4
    ; Some NSIS file instructions do not preserve GetLastError.
    ${If} $L2SoloAccessError == 0
      StrCpy $L2SoloAccessError 5
    ${EndIf}
  probeReturn:
    ClearErrors
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

!endif
