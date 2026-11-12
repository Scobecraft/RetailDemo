#!/usr/bin/env bash
# Baut Druckmonitor.exe und den Installer dist/Druckmonitor-Setup-<VERSION>.exe (unter Linux/macOS).
# Voraussetzungen: Go 1.24, NSIS (makensis; Ubuntu: apt install nsis)
# Neue Version: Nummer in VERSION erhöhen, dieses Skript ausführen und den Installer auf der
# Retail-Demo-Webseite unter Einstellungen → App-Updates hochladen.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(tr -d ' \n\r' < VERSION)
mkdir -p dist
# Versionsangaben ins EXE-Icon/Manifest
tmp=$(mktemp -d)
sed -e "s/\"1\.0\.0\.0\"/\"$VERSION.0\"/g" -e "s/\"1\.0\.0\"/\"$VERSION\"/g" winres/winres.json > "$tmp/winres.json"
cp winres/*.png "$tmp/"
go run github.com/tc-hib/go-winres@v0.3.3 make --in "$tmp/winres.json" --arch amd64
rm -rf "$tmp"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=$VERSION" -o dist/Druckmonitor.exe .
rm -f rsrc_windows_amd64.syso
makensis -V2 -DVERSION="$VERSION" installer/druckmonitor.nsi
echo "Fertig: dist/Druckmonitor-Setup-$VERSION.exe"
