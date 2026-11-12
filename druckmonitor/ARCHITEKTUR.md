# Druckmonitor – Architektur

Vollbild-Übersicht für einen Flashforge-3D-Drucker (getestet gegen Simulation, im Einsatz mit
Adventurer 5M-Serie): links die Live-Kamera, rechts das sich drehende 3D-Modell mit Druckfortschritt
und Druckdaten. Geschrieben in Go (Backend, ein einziges Binary) plus HTML/JS (Oberfläche, eingebettet
per `go:embed`).

## Aufbau

| Datei | Aufgabe |
|---|---|
| `main.go` | Konfiguration, lokaler HTTP-Server, alle `/api/*`-Endpunkte, Modell-Speicherung |
| `stream.go` | Kamera: MJPEG-/Einzelbild-Empfang mit Watchdog (Neuverbindung bei Hängern) |
| `printer.go` | Live-Druckerdaten: Flashforge HTTP-API (8898) bzw. TCP-Protokoll (8899) |
| `discover.go` | Automatische Druckersuche (UDP-Discovery, Flash-Studio-Hinweise, Scan) + IP-Wächter |
| `jobfile.go` | Sucht die Datei des laufenden Drucks auf dem PC und lädt sie als Modell |
| `filemeta.go` | Liest Slicer-Angaben (Druckzeit, Filament, Schichthöhe …) aus G-Code / 3MF |
| `scan.go` | Netzwerkscan (/24-Netze) auf einen Port |
| `shell_windows.go` | **Windows-only**: Fenster (WebView2), Vollbild, Monitorwahl, Standby-Sperre |
| `shell_other.go` | Alle anderen OS: kein Fenster, nur Server (Adresse wird ausgegeben) |
| `web/` | Oberfläche: `setup.html`, `monitor.html`, `viewer.js` (three.js), `camworker.js` |
| `web/vendor/` | three.js r170 (MIT, siehe `THREE-LICENSE.txt`) – bewusst lokal, läuft offline |
| `winres/` | Icon/Manifest-Quellen für die Windows-EXE (`go-winres make --in winres/winres.json`) |
| `obs-overlay/overlay.html` | Älteres, eigenständiges OBS-Overlay (transparente Fenster), kein Teil des Servers |

## Übertragung an den Retail-Demo-Server (`push.go`)

Sind in den Einstellungen unter „Webseite (Retail-Demo-Server)“ Adresse und Geräte-Token (`DEVICE_TOKEN`
des Servers) eingetragen, schickt die App ihre Daten an den Server (`server/app/druck.py`). Dort zeigt die
Verwaltungs-Webseite sie im Reiter „3D-Drucker“ mit derselben `monitor.html` an (Server liefert sie unter
`/druck/` aus und beantwortet deren `api/*`-Abfragen). Der Server muss den Drucker nicht erreichen können.

| Daten | Endpunkt (Bearer `DEVICE_TOKEN`) | Wann |
|---|---|---|
| Druckerdaten, Kamerastatus, Anzeige-Texte (JSON) | `POST /api/druck/state` | alle 2 s; Antwort `{"watching": bool}` |
| Kamerabild (JPEG) | `POST /api/druck/frame` | bis ca. 5/s, solange jemand zuschaut, sonst alle 30 s |
| Modell (Rohdaten, `?name=&file=`) | `POST /api/druck/model` | bei jedem Modellwechsel (max. 90 MB) |

Der State enthält außerdem `pc` (PC-Messwerte, `sysstats*.go`) und etwa jede Minute `pcInfo` (verbaute
Hardware). Unter Windows: CPU/RAM/Laufwerke über die Windows-API, Kerne/Netzwerk/Datenträger/GPU/Prozesse
über einen unsichtbaren PowerShell-Prozess (WMI-Klassen `Win32_PerfFormattedData_*`, nicht übersetzt),
NVIDIA-Werte über `nvidia-smi -l 2`, Hardware einmalig per WMI. Hilfsprozesse hängen an einem Job-Objekt
(enden mit der App) und laufen nur, solange an den Server gesendet wird.

Seriennummer, Prüfcode, Drucker-IP und Kamera-Adresse werden **nicht** übertragen. Alle Seiten verwenden
relative Pfade (`api/…`, `vendor/…`), damit sie sowohl unter `/` (App) als auch unter `/druck/` (Server) laufen.

## Kommunikation mit dem Drucker

Quelle der Protokolldetails: Community-Doku <https://github.com/Parallel-7/flashforge-api-docs>
(nicht offiziell von Flashforge).

| Zweck | Port / Protokoll | Details |
|---|---|---|
| Kamera | `http://IP:8080/?action=stream` (MJPEG, mjpg-streamer) | URL-Vorlage frei einstellbar, `{ip}` wird ersetzt. Bilder werden per JPEG-Marker (FFD8/FFD9) aus dem Stream geschnitten. Watchdog: 6 s kein Bild oder 45 s identisches Bild → Neuverbindung. Antwortet die URL mit `image/*`, wird gepollt; mit `text/html` wird die Seite als iframe eingebettet. |
| Druckerdaten (voll) | HTTP `POST http://IP:8898/detail`, Body `{"serialNumber","checkCode"}` | Liefert Status, `printProgress` (0–1), Schicht, `printDuration`, `estimatedTime` (Restzeit), Temperaturen, Geschwindigkeit, Lüfter, Filament. `code` 1 = Seriennummer/Prüfcode falsch, -2 = LAN-Modus aus. |
| Druckerdaten (Basis, ohne Zugangsdaten) | TCP `IP:8899`, Befehle `~M601 S1` (Sitzung), `~M115` (Name/Firmware/SN), `~M119` (Status, aktuelle Datei), `~M105` (Temperaturen), `~M27` (Fortschritt/Schicht), `~M602` (Sitzung freigeben) | Wird alle 2 s neu verbunden und sofort wieder freigegeben, damit Flash Studio nicht blockiert. Restzeit wird hier selbst aus dem Drucktempo hochgerechnet. |
| Suche | UDP: leeres Paket an `225.0.0.9:19000`, `225.0.0.9:8899`, `255.255.255.255:{48899,19000,8899}` und Subnetz-Broadcasts | Antwort ≥276 Byte (modern): Name @0x00, PID @0x88, Seriennummer @0x92; 140 Byte = Alt-Geräte. |

**Prüfcode (checkCode)**: steht am Druckerdisplay (Einstellungen → Netzwerk/Info, je nach Firmware
„Nur-LAN-Modus“). Wird nur in der lokalen Konfiguration gespeichert, nie im Code.

**IP-Ermittlung** (`discoverPrinters`): zuletzt bekannte IP → UDP-Discovery → IP-Adressen aus
Flash-Studio-/Orca-Konfigdateien (jede wird vor Übernahme am Drucker geprüft) → Scan auf Port 8899.
Bei bekannter Seriennummer wird genau dieser Drucker gewählt. `watchIP` sucht neu, wenn Kamera oder
Druckerdaten ≥30 s nicht erreichbar sind, und stellt dann alles auf die neue IP um.

## Vom Programm ausgelieferte Seiten und Endpunkte

Der Server lauscht auf `127.0.0.1:<zufälliger Port>` (siehe `main()`). Für einen Server-Betrieb müsste
die Listen-Adresse konfigurierbar gemacht werden (z. B. `0.0.0.0:8090`).

| Pfad | Methode | Zweck |
|---|---|---|
| `/` | GET | Einstellungsseite (`web/setup.html`) |
| `/monitor` | GET | Vollbildansicht 1920×1080, skaliert (`web/monitor.html`) |
| `/logo.png`, `/viewer.js`, `/camworker.js`, `/vendor/…` | GET | statische Dateien |
| `/api/config` | GET | aktuelle Konfiguration (JSON) |
| `/api/start` | POST | Konfiguration übernehmen (JSON-Body, Teilfelder erlaubt), ggf. Drucker suchen, Kamera + Druckerdaten starten |
| `/api/stop` | GET/POST | Kamera + Druckerdaten stoppen |
| `/api/frame?after=<seq>` | GET | neuestes Kamerabild (JPEG), Long-Poll bis 3 s; Header `X-Seq`; 204 wenn nichts Neues |
| `/api/status` | GET | Kamera-Status (state, kind, fps, Fehler, Neuverbindungen) |
| `/api/printer` | GET | `{live: PrinterInfo, file: FileMeta, kind, modelRev, modelName, modelSource}` |
| `/api/printer/test?ip=&serial=&code=` | GET | einmalige Druckerabfrage für den Dialog |
| `/api/discover[?full=1&serial=&template=]` | GET | Drucker suchen |
| `/api/scan?template=` | GET | Netzwerkscan auf den Port der URL-Vorlage |
| `/api/test?url=` | GET | Kamera-URL testen (inkl. Vorschaubild als data-URL) |
| `/api/model` | GET / POST `?name=` / DELETE | aktuelles Modell abrufen (Header `X-Model-Name`), hochladen (Rohdaten im Body), löschen |
| `/api/monitors`, `/api/window?fullscreen=0/1&monitor=n`, `/api/window?quit=1` | GET | Fenstersteuerung – nur unter Windows wirksam |

Das OBS-Overlay (`obs-overlay/overlay.html`) ist eine statische Seite und wird **nicht** vom Server
ausgeliefert.

## Einstellungen und Dateien

`os.UserConfigDir()/Druckmonitor/`:
- Windows: `%APPDATA%\Druckmonitor\`
- Linux: `$XDG_CONFIG_HOME/Druckmonitor/` bzw. `~/.config/Druckmonitor/`

Inhalt: `config.json` (IP, Kamera-URL-Vorlage, Seriennummer, Prüfcode, Texte, Farben …),
`modell.<ext>` (aktuelles Modell), `druckmonitor.log`, unter Windows zusätzlich `WebView2/`.

## Windows-spezifisch vs. plattformneutral

- **Nur Windows** (`shell_windows.go`, Build-Tag `windows`): WebView2-Fenster, Vollbild/Monitorwahl über
  Win32, Standby-Sperre, Fehlermeldungs-Dialog, EXE-Icon/Manifest (`winres/`, `rsrc_*.syso`).
- **Plattformneutral**: alles andere. Unter Linux (`shell_other.go`) läuft derselbe Server ohne Fenster;
  die Oberfläche wird im Browser geöffnet. So wurde das Programm auch getestet.
- Hinweise für einen Linux-Server/Docker-Betrieb:
  - Listen-Adresse in `main()` ist fest `127.0.0.1:0` → für Docker konfigurierbar machen.
  - UDP-Discovery braucht Broadcast/Multicast im Drucker-Netz → im Container `network_mode: host`
    (bzw. Macvlan), sonst erreicht die Suche den Drucker nicht. Feste IP + `autoIp=false` geht immer.
  - `jobfile.go` (Druckdatei auf dem PC suchen) und `flashStudioIPs()` durchsuchen lokale
    Benutzerordner (APPDATA, Temp, Downloads …). Auf einem Server sind die nutzlos – dort Modelle per
    `/api/model` hochladen bzw. `autoModel=false`.
  - Die Vollbildansicht ist auf 1920×1080 ausgelegt und skaliert; als Reiter in einer anderen Seite
    eignet sich ein `<iframe src="…/monitor">` oder das Übernehmen von `monitor.html`.

## Bauen und Testen

```bash
go test ./...                       # Unit-Tests (Slicer-Dateien, Drucker-Antworten, Discovery, Dateisuche)
go build -o druckmonitor .          # Linux: Server ohne Fenster
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o Druckmonitor.exe .
```

Für das EXE-Icon vorher `go run github.com/tc-hib/go-winres@v0.3.3 make --in winres/winres.json --arch amd64`
(erzeugt `rsrc_windows_amd64.syso`, nicht eingecheckt).
