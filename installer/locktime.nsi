!include "MUI2.nsh"

;--------------------------------
; General
;--------------------------------

Name "LockTime"
OutFile "locktime-installer.exe"
InstallDir "$PROGRAMFILES64\locktime"
InstallDirRegKey HKLM "Software\LockTime" "InstallDir"
RequestExecutionLevel admin

!define PRODUCT_NAME "LockTime"
!define PRODUCT_VERSION "1.0.0"
!define PRODUCT_PUBLISHER "lambertse"
!define SERVICE_NAME "locktime"

;--------------------------------
; MUI2 Settings
;--------------------------------

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

;--------------------------------
; Installer Section
;--------------------------------

Section "Install" SecInstall

  SetOutPath "$INSTDIR"

  ; Copy binaries
  File "locktime-svc.exe"
  File "blocker.exe"

  ; Copy frontend dist files
  File /r "dist"

  ; Copy nginx (nginx.conf is written at runtime by the service)
  File /r "nginx"
  CreateDirectory "$INSTDIR\nginx\logs"
  CreateDirectory "$INSTDIR\nginx\temp"

  ; Register and start the Windows service
  ExecWait '"$INSTDIR\locktime-svc.exe" --install'
  ExecWait 'net start ${SERVICE_NAME}'

  ; Write uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Registry entry for uninstall
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LockTime" \
    "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LockTime" \
    "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LockTime" \
    "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LockTime" \
    "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "Software\LockTime" "InstallDir" "$INSTDIR"

  ; Start Menu shortcut
  CreateDirectory "$SMPROGRAMS\LockTime"
  WriteIniStr "$SMPROGRAMS\LockTime\LockTime Dashboard.url" "InternetShortcut" \
    "URL" "http://localhost:8090"
  WriteIniStr "$SMPROGRAMS\LockTime\LockTime Dashboard.url" "InternetShortcut" \
    "IconFile" "$INSTDIR\locktime-svc.exe"
  WriteIniStr "$SMPROGRAMS\LockTime\LockTime Dashboard.url" "InternetShortcut" \
    "IconIndex" "0"

  ; Open dashboard in browser
  ExecShell "open" "http://localhost:8090"

SectionEnd

;--------------------------------
; Uninstaller Section
;--------------------------------

Section "Uninstall"

  ; Stop and unregister the service
  ExecWait 'net stop ${SERVICE_NAME}'
  ExecWait '"$INSTDIR\locktime-svc.exe" --uninstall'

  ; Remove installed files
  Delete "$INSTDIR\locktime-svc.exe"
  Delete "$INSTDIR\blocker.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\nginx"
  RMDir "$INSTDIR"

  ; Remove Start Menu shortcuts
  Delete "$SMPROGRAMS\LockTime\LockTime Dashboard.url"
  RMDir "$SMPROGRAMS\LockTime"

  ; Remove registry entries
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LockTime"
  DeleteRegKey HKLM "Software\LockTime"

SectionEnd
