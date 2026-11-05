; The 0.1.0 custom installer used this location and a different uninstall key.
; Reuse the directory, and remove only its registration after successful install.
!macro preInit
  ReadRegStr $0 HKCU "Software\MailGrid" "InstallLocation"
  StrCmp $0 "" migration_done
  StrCmp $0 "$LOCALAPPDATA\Programs\Mail Grid" legacy_default legacy_custom
  legacy_custom:
    MessageBox MB_OK|MB_ICONEXCLAMATION "Your older Mail Grid copy uses a custom folder. Uninstall it using its original uninstaller, then run this installer again. Your saved mail and settings will be kept."
    Abort
  legacy_default:
    StrCpy $INSTDIR $0
  migration_done:
!macroend
!macro customInstall
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MailGrid"
  DeleteRegKey HKCU "Software\MailGrid"
  ; The new installer replaces the legacy uninstaller at the same path.
  ; Do not delete that path here: it now belongs to the new installer.
!macroend
