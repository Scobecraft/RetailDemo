# Retail Demo Offline – Laptop einmalig einrichten und absichern
# Wird über "Laptop-einrichten.cmd" als Administrator gestartet.
#
# - Admin-Konto bekommt ein Passwort (alles Sensible fragt danach)
# - Neues eingeschränktes Konto "Vorfuehrung" ohne Passwort, meldet sich automatisch an
# - Demo wird beim ersten Anmelden von "Vorfuehrung" still installiert und startet ab dann immer automatisch
# - Gesperrt: WLAN, Passwort ändern, Sprache/Region, Konten, Netzwerk, Apps deinstallieren,
#   Task-Manager, Eingabeaufforderung, PowerShell, Registry, Microsoft-Konto-Anmeldung
# Rückgängig: "Absicherung-aufheben.cmd"

$ErrorActionPreference = "Stop"
$DemoUser = "Vorfuehrung"
$DataDir = "C:\ProgramData\RetailDemo"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }

function Set-Reg($path, $name, $value, $type = "DWord") {
  if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
  New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null
}

Write-Host "Retail Demo Offline - Laptop einrichten" -ForegroundColor White
Write-Host "----------------------------------------"

# ---------------------------------------------------------------- Setup-Datei suchen
$setup = Get-ChildItem -Path $Here -Filter "RetailDemo-Offline-Setup-*.exe" -ErrorAction SilentlyContinue |
  Sort-Object { [version]($_.BaseName -replace '^RetailDemo-Offline-Setup-', '') } -Descending | Select-Object -First 1
if (-not $setup) {
  Write-Host "Keine Datei RetailDemo-Offline-Setup-x.y.z.exe neben diesem Skript gefunden." -ForegroundColor Red
  Read-Host "Enter zum Beenden"; exit 1
}
Ok "Demo-Programm: $($setup.Name)"

$me = $env:USERNAME
if ($me -eq $DemoUser) {
  Write-Host "Bitte dieses Skript mit dem Admin-Konto ausfuehren, nicht als $DemoUser." -ForegroundColor Red
  Read-Host "Enter zum Beenden"; exit 1
}

# ---------------------------------------------------------------- 1. Admin-Passwort
Step "Passwort fuer das Admin-Konto '$me'"
Write-Host "    Mit diesem Passwort lassen sich spaeter alle gesperrten Einstellungen aendern."
$answer = Read-Host "    Neues Passwort festlegen? (j = ja, Enter = vorhandenes Passwort behalten)"
if ($answer -match '^[jJyY]') {
  while ($true) {
    $p1 = Read-Host "    Neues Passwort" -AsSecureString
    $p2 = Read-Host "    Passwort wiederholen" -AsSecureString
    $s1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1))
    $s2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2))
    if ($s1.Length -lt 4) { Warn "Mindestens 4 Zeichen."; continue }
    if ($s1 -ne $s2) { Warn "Die Passwoerter stimmen nicht ueberein."; continue }
    Set-LocalUser -Name $me -Password $p1
    Ok "Passwort gesetzt. Gut aufbewahren!"
    break
  }
}

# ---------------------------------------------------------------- 2. Konto "Vorfuehrung"
Step "Eingeschraenktes Konto '$DemoUser' anlegen"
$usersGroup = Get-LocalGroup -SID "S-1-5-32-545"     # "Benutzer" (Name ist sprachabhaengig)
$adminGroup = Get-LocalGroup -SID "S-1-5-32-544"     # "Administratoren"
if (-not (Get-LocalUser -Name $DemoUser -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name $DemoUser -FullName "Vorfuehrung" -Description "Demo-Konto fuer die Ausstellung" `
    -NoPassword -UserMayNotChangePassword -AccountNeverExpires | Out-Null
  Ok "Konto angelegt"
} else { Ok "Konto existiert schon" }
Set-LocalUser -Name $DemoUser -PasswordNeverExpires $true -UserMayChangePassword $false
Enable-LocalUser -Name $DemoUser
# Fehler "ist bereits Mitglied" bzw. "ist kein Mitglied" sind hier in Ordnung
try { Add-LocalGroupMember -Group $usersGroup -Member $DemoUser -ErrorAction Stop } catch {}
try { Remove-LocalGroupMember -Group $adminGroup -Member $DemoUser -ErrorAction Stop } catch {}
Ok "Keine Admin-Rechte, Passwort kann nicht gesetzt werden"

# ---------------------------------------------------------------- 3. Demo-Programm bereitlegen
Step "Demo-Programm bereitlegen"
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
Copy-Item $setup.FullName "$DataDir\RetailDemo-Offline-Setup.exe" -Force
Ok "Kopiert nach $DataDir"

# ---------------------------------------------------------------- 4. Sperren fuer das Konto "Vorfuehrung"
Step "Sperren fuer '$DemoUser' setzen"
# Gibt es das Profil schon (Konto war schon angemeldet), dessen Registry laden, sonst die Vorlage
# fuer neue Konten (C:\Users\Default) – daraus entsteht beim ersten Anmelden das Profil.
$demoProfile = Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like "*\$DemoUser" } | Select-Object -First 1
$hiveFile = if ($demoProfile) { Join-Path $demoProfile.LocalPath "NTUSER.DAT" } else { "C:\Users\Default\NTUSER.DAT" }
if ($demoProfile -and $demoProfile.Loaded) {
  Write-Host "    '$DemoUser' ist gerade angemeldet. Bitte abmelden und das Skript erneut starten." -ForegroundColor Red
  Read-Host "Enter zum Beenden"; exit 1
}
& reg.exe load "HKU\RDTemp" "$hiveFile" | Out-Null
try {
  $u = "Registry::HKEY_USERS\RDTemp"
  # Demo beim (ersten) Anmelden still installieren; danach traegt sich die Demo selbst in den Autostart ein
  Set-Reg "$u\Software\Microsoft\Windows\CurrentVersion\RunOnce" "RetailDemoInstall" "`"$DataDir\RetailDemo-Offline-Setup.exe`" /S --force-run" "String"
  # Passwort aendern (Strg+Alt+Entf), Task-Manager, Registry-Editor
  $sys = "$u\Software\Microsoft\Windows\CurrentVersion\Policies\System"
  Set-Reg $sys "DisableChangePassword" 1
  Set-Reg $sys "DisableTaskMgr" 1
  Set-Reg $sys "DisableRegistryTools" 1
  # Eingabeaufforderung (2 = nur die interaktive Eingabe sperren, Programme duerfen sie intern nutzen)
  Set-Reg "$u\Software\Policies\Microsoft\Windows\System" "DisableCMD" 2
  # Systemsteuerung: nur Maus und Sound
  $exp = "$u\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"
  Set-Reg $exp "RestrictCpl" 1
  Set-Reg "$exp\RestrictCpl" "1" "Microsoft.Mouse" "String"
  Set-Reg "$exp\RestrictCpl" "2" "Microsoft.Sound" "String"
  # Programme, die Kunden nicht starten sollen
  Set-Reg $exp "DisallowRun" 1
  $i = 1
  foreach ($exe in "powershell.exe", "powershell_ise.exe", "pwsh.exe", "wt.exe", "regedit.exe", "mmc.exe", "netsh.exe", "msconfig.exe") {
    Set-Reg "$exp\DisallowRun" "$i" $exe "String"; $i++
  }
  # Keine "Einrichtung abschliessen"-Hinweise von Windows
  Set-Reg "$u\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement" "ScoobeSystemSettingEnabled" 0
  Ok "Passwort aendern, Task-Manager, Registry, Eingabeaufforderung, PowerShell gesperrt"
} finally {
  [gc]::Collect(); Start-Sleep -Milliseconds 500
  & reg.exe unload "HKU\RDTemp" | Out-Null
}

# ---------------------------------------------------------------- 5. Sperren fuer den ganzen Laptop
Step "Einstellungen-App einschraenken"
# Nur diese Seiten bleiben sichtbar: Anzeige, Nachtmodus, Sound, Bluetooth, Maus/Touchpad, Stift, Info
Set-Reg "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer" "SettingsPageVisibility" `
  "showonly:display;nightlight;sound;bluetooth;mousetouchpad;devices-touchpad;pen;about" "String"
Ok "Konten, Passwort, Sprache/Region, Datum/Uhrzeit, Netzwerk & Internet, Apps, Update, Wiederherstellung ausgeblendet"

Step "Microsoft-Konto-Anmeldung sperren"
Set-Reg "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" "NoConnectedUser" 3
Ok "Kein Anmelden/Hinzufuegen von Microsoft-Konten"

Step "WLAN sperren"
& netsh.exe wlan add filter permission=denyall networktype=infrastructure | Out-Null
& netsh.exe wlan add filter permission=denyall networktype=adhoc | Out-Null
if ($LASTEXITCODE -eq 0) { Ok "Keine WLAN-Netze sichtbar oder verbindbar" } else { Warn "WLAN-Sperre nicht gesetzt (kein WLAN-Adapter oder WLAN-Dienst aus)" }

Step "Automatische Anmeldung als '$DemoUser'"
$wl = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-Reg $wl "AutoAdminLogon" "1" "String"
Set-Reg $wl "DefaultUserName" $DemoUser "String"
Set-Reg $wl "DefaultPassword" "" "String"
Set-Reg $wl "DefaultDomainName" $env:COMPUTERNAME "String"
# Windows 11: "Nur Windows Hello" verhindert sonst die automatische Anmeldung
Set-Reg "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device" "DevicePasswordLessBuildVersion" 0
Ok "Nach dem Einschalten startet direkt die Demo"

# Beim ersten Anmelden keine Datenschutz-Fragen und keine "Hallo"-Animation (sonst muesste jemand klicken)
Set-Reg "HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE" "DisablePrivacyExperience" 1
Set-Reg "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" "EnableFirstLogonAnimation" 0

Step "Energie: nie in den Ruhezustand, Schnellstart aus"
& powercfg.exe /change standby-timeout-ac 0 | Out-Null
& powercfg.exe /change monitor-timeout-ac 0 | Out-Null
& powercfg.exe /change standby-timeout-dc 0 | Out-Null
& powercfg.exe /change monitor-timeout-dc 0 | Out-Null
# Schnellstart aus: Herunterfahren ist dann ein echtes Ausschalten
Set-Reg "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power" "HiberbootEnabled" 0
Ok "Erledigt"

Write-Host ""
Write-Host "Fertig! Nach dem Neustart meldet sich '$DemoUser' automatisch an," -ForegroundColor Green
Write-Host "die Demo installiert sich (ca. 30 Sekunden) und startet." -ForegroundColor Green
$r = Read-Host "Jetzt neu starten? (j = ja)"
if ($r -match '^[jJyY]') { Restart-Computer -Force }
