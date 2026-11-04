@echo off
rem Startet einrichten.ps1 als Administrator (Windows fragt nach Bestaetigung).
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0einrichten.ps1"
