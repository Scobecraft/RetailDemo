# Retail Demo Offline – Absicherung wieder aufheben (z. B. bevor ein Laptop verkauft wird)
# Wird über "Absicherung-aufheben.cmd" als Administrator gestartet.
$ErrorActionPreference = "Continue"
$DemoUser = "Vorfuehrung"

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }

Step "Einstellungen-App und Microsoft-Konto wieder freigeben"
Remove-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer" "SettingsPageVisibility" -ErrorAction SilentlyContinue
Remove-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" "NoConnectedUser" -ErrorAction SilentlyContinue

Step "WLAN wieder freigeben"
& netsh.exe wlan delete filter permission=denyall networktype=infrastructure | Out-Null
& netsh.exe wlan delete filter permission=denyall networktype=adhoc | Out-Null

Step "Automatische Anmeldung aus"
$wl = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-ItemProperty $wl "AutoAdminLogon" "0"
Remove-ItemProperty $wl "DefaultPassword" -ErrorAction SilentlyContinue

Step "Sperren aus der Vorlage fuer neue Konten entfernen"
& reg.exe load "HKU\RDTemp" "C:\Users\Default\NTUSER.DAT" | Out-Null
foreach ($k in "Software\Microsoft\Windows\CurrentVersion\Policies\System", "Software\Policies\Microsoft\Windows\System",
                "Software\Microsoft\Windows\CurrentVersion\Policies\Explorer") {
  foreach ($v in "DisableChangePassword", "DisableTaskMgr", "DisableRegistryTools", "DisableCMD", "RestrictCpl", "DisallowRun") {
    Remove-ItemProperty "Registry::HKEY_USERS\RDTemp\$k" $v -ErrorAction SilentlyContinue
  }
}
Remove-Item "Registry::HKEY_USERS\RDTemp\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\RestrictCpl" -Recurse -ErrorAction SilentlyContinue
Remove-Item "Registry::HKEY_USERS\RDTemp\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun" -Recurse -ErrorAction SilentlyContinue
Remove-ItemProperty "Registry::HKEY_USERS\RDTemp\Software\Microsoft\Windows\CurrentVersion\RunOnce" "RetailDemoInstall" -ErrorAction SilentlyContinue
[gc]::Collect(); Start-Sleep -Milliseconds 500
& reg.exe unload "HKU\RDTemp" | Out-Null

$r = Read-Host "Konto '$DemoUser' samt Demo loeschen? (j = ja)"
if ($r -match '^[jJyY]') {
  Remove-LocalUser -Name $DemoUser -ErrorAction SilentlyContinue
  Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like "*\$DemoUser" -and -not $_.Loaded } | Remove-CimInstance
  Write-Host "Konto und Profil geloescht." -ForegroundColor Green
}
Write-Host ""
Write-Host "Fertig. Bitte neu starten." -ForegroundColor Green
Read-Host "Enter zum Beenden"
