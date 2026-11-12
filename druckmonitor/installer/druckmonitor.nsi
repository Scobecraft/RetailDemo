; Druckmonitor – Installer (NSIS 3)
; Installiert ohne Administratorrechte für den angemeldeten Benutzer nach
; %LOCALAPPDATA%\Programs\Druckmonitor. So kann sich die App später selbst aktualisieren.
;
; Bauen: siehe build-windows.sh (makensis -DVERSION=x.y.z installer/druckmonitor.nsi)
; Aufruf durch die App beim Update: Druckmonitor-Setup.exe /S /UPDATE

Unicode true
Target amd64-unicode ; die App ist ohnehin 64 Bit
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !error "VERSION fehlt (makensis -DVERSION=1.2.3)"
!endif

!define APP      "Druckmonitor"
!define EXE      "Druckmonitor.exe"
!define UNINST   "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
!define RUNKEY   "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APP} ${VERSION}"
OutFile "..\dist\Druckmonitor-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\${APP}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APP} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1031 "ProductName" "${APP}"
VIAddVersionKey /LANG=1031 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1031 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1031 "FileDescription" "${APP} Installation"
VIAddVersionKey /LANG=1031 "LegalCopyright" "${APP}"

!define MUI_ICON "druckmonitor.ico"
!define MUI_UNICON "druckmonitor.ico"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_NODESC
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Druckmonitor jetzt starten"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "German"

Var Update ; 1 = stilles Update durch die App

Function .onInit
  StrCpy $Update 0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    StrCpy $Update 1
  ${EndIf}
FunctionEnd

; Laufende App beenden (beim Update beendet sie sich selbst; zur Sicherheit kurz warten)
!macro StopApp
  Sleep 1500
  nsExec::Exec 'taskkill /IM "${EXE}" /T /F'
  Pop $0
  Sleep 800
!macroend

Section "Druckmonitor" SecMain
  SectionIn RO
  !insertmacro StopApp
  SetOutPath "$INSTDIR"
  SetOverwrite on
  ; Datei kann nach dem Beenden noch kurz gesperrt sein -> mehrmals versuchen
  StrCpy $1 0
  retry:
  ClearErrors
  File "..\dist\${EXE}"
  ${If} ${Errors}
    IntOp $1 $1 + 1
    ${If} $1 < 10
      Sleep 1000
      Goto retry
    ${EndIf}
    MessageBox MB_ICONSTOP "Druckmonitor.exe konnte nicht ersetzt werden. Bitte die App schließen und erneut versuchen." /SD IDOK
    Abort
  ${EndIf}
  File "druckmonitor.ico"
  WriteUninstaller "$INSTDIR\Deinstallieren.exe"

  WriteRegStr HKCU "Software\${APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST}" "Publisher" "Retail Demo"
  WriteRegStr HKCU "${UNINST}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "UninstallString" '"$INSTDIR\Deinstallieren.exe"'
  WriteRegStr HKCU "${UNINST}" "QuietUninstallString" '"$INSTDIR\Deinstallieren.exe" /S'
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST}" "EstimatedSize" $0

  ; Startmenü (bei Updates nur auffrischen)
  CreateShortCut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
SectionEnd

Section "Verknüpfung auf dem Desktop" SecDesktop
  ${If} $Update == 0
    CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  ${EndIf}
SectionEnd

Section "Beim Windows-Start automatisch starten (Vollbild)" SecAutostart
  ; Beim stillen Update die bisherige Wahl nicht verändern
  ${If} $Update == 0
    WriteRegStr HKCU "${RUNKEY}" "${APP}" '"$INSTDIR\${EXE}" --autostart'
  ${EndIf}
SectionEnd

Section "-Nach dem Update neu starten"
  ${If} $Update == 1
    Exec '"$INSTDIR\${EXE}" --autostart'
  ${EndIf}
SectionEnd

Function .onSelChange
FunctionEnd

; Wurde die Autostart-Option abgewählt, einen alten Eintrag entfernen
Function .onInstSuccess
  ${If} $Update == 0
    ${IfNot} ${SectionIsSelected} ${SecAutostart}
      DeleteRegValue HKCU "${RUNKEY}" "${APP}"
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${EXE}" /T /F'
  Pop $0
  Sleep 800
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\druckmonitor.ico"
  Delete "$INSTDIR\Deinstallieren.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegValue HKCU "${RUNKEY}" "${APP}"
  DeleteRegKey HKCU "${UNINST}"
  DeleteRegKey HKCU "Software\${APP}"
  ; Einstellungen (%APPDATA%\Druckmonitor) bleiben erhalten – für eine spätere Neuinstallation
SectionEnd
