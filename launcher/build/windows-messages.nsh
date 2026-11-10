; Upstream also uses appCannotBeClosed for copy and old-uninstaller failures.
; Replace that catch-all in every bundled language with an accurate explanation.
!macro L2SoloFileError LANGUAGE
  !ifdef LANG_${LANGUAGE}
    LangString appCannotBeClosed ${LANG_${LANGUAGE}} "Setup could not replace or remove application files. Close applications using the installation folder and check its permissions, available disk space and security software. Retry to try again, or Cancel to stop Setup."
  !endif
!macroend

!macro L2SoloInstallerMessages
  !pragma warning push
  !pragma warning disable 6030 ; Intentionally replace electron-builder's text.
  !insertmacro L2SoloFileError ENGLISH
  !insertmacro L2SoloFileError GERMAN
  !insertmacro L2SoloFileError FRENCH
  !insertmacro L2SoloFileError SPANISHINTERNATIONAL
  !insertmacro L2SoloFileError SIMPCHINESE
  !insertmacro L2SoloFileError TRADCHINESE
  !insertmacro L2SoloFileError JAPANESE
  !insertmacro L2SoloFileError KOREAN
  !insertmacro L2SoloFileError ITALIAN
  !insertmacro L2SoloFileError DUTCH
  !insertmacro L2SoloFileError DANISH
  !insertmacro L2SoloFileError SWEDISH
  !insertmacro L2SoloFileError NORWEGIAN
  !insertmacro L2SoloFileError FINNISH
  !insertmacro L2SoloFileError RUSSIAN
  !insertmacro L2SoloFileError PORTUGUESE
  !insertmacro L2SoloFileError PORTUGUESEBR
  !insertmacro L2SoloFileError POLISH
  !insertmacro L2SoloFileError UKRAINIAN
  !insertmacro L2SoloFileError CZECH
  !insertmacro L2SoloFileError SLOVAK
  !insertmacro L2SoloFileError HUNGARIAN
  !insertmacro L2SoloFileError ARABIC
  !insertmacro L2SoloFileError TURKISH
  !insertmacro L2SoloFileError THAI
  !insertmacro L2SoloFileError VIETNAMESE
  !pragma warning pop
!macroend
