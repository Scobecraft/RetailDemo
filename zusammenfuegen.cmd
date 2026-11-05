@echo off
rem Fuegt die beiden Teile wieder zur Setup-Datei zusammen.
cd /d "%~dp0"
copy /b "RetailDemo-Offline-Setup-1.0.7.exe.teil0"+"RetailDemo-Offline-Setup-1.0.7.exe.teil1" "RetailDemo-Offline-Setup-1.0.7.exe" >nul
if exist "RetailDemo-Offline-Setup-1.0.7.exe" (echo Fertig: RetailDemo-Offline-Setup-1.0.7.exe) else (echo Fehler: Beide Teile muessen im selben Ordner liegen wie diese Datei.)
pause
