; installer.nsh - Custom NSIS hooks for LockTime
; Handles the Go background service (locktime-svc.exe) lifecycle.

!define SERVICE_NAME "LockTimeSvc"

; Called after Electron app files are copied to $INSTDIR
!macro customInstall
  DetailPrint "Installing LockTime background service..."

  ; electron-builder puts extraResources in $INSTDIR\resources\bin
  CopyFiles "$INSTDIR\resources\bin\locktime-svc.exe" "$INSTDIR"
  CopyFiles "$INSTDIR\resources\bin\blocker.exe" "$INSTDIR"

  ExecWait '"$INSTDIR\locktime-svc.exe" --install' $0
  DetailPrint "Service install exit code: $0"

  ExecWait 'net start ${SERVICE_NAME}' $0
  DetailPrint "Service start exit code: $0"

  CreateDirectory "$APPDATA\locktime"
!macroend

; Called before app files are removed
!macro customUninstall
  DetailPrint "Stopping and removing LockTime background service..."

  ExecWait 'net stop ${SERVICE_NAME}' $0
  DetailPrint "Service stop exit code: $0"

  ExecWait '"$INSTDIR\locktime-svc.exe" --uninstall' $0
  DetailPrint "Service uninstall exit code: $0"

  Delete "$INSTDIR\locktime-svc.exe"
  Delete "$INSTDIR\blocker.exe"
!macroend
