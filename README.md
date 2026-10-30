# Retail Demo – Demo-Software für Ausstellungsgeräte

Vier Teile:

| Teil | Wo | Aufgabe |
|---|---|---|
| `server/` | Docker auf Proxmox | speichert Videos/Bilder, Playlists, Geräteliste, Laden-Logo |
| Admin-App (`android/admin`) | dein Handy | Medien hochladen/löschen, Playlists, Geräte verwalten |
| Demo-App (`android/demo`) | Ausstellungs-Handys | lädt Inhalte (1×/Stunde), spielt sie in Schleife, zeigt Name + Specs |
| Laptop-Demo (`laptop/`) | Ausstellungs-Laptops (Mac, Windows) | wie Intel iPOS: animierte Spec-Präsentation mit Logo, Videos, Spec-Lasche am Rand |

---

## 1. Server auf Proxmox einrichten

Am einfachsten in einem **LXC-Container mit Debian/Ubuntu** (oder einer VM) mit installiertem Docker.

```bash
# Ordner "server" auf den Container kopieren, z. B. per scp
cd server
cp .env.example .env
openssl rand -hex 24   # -> als ADMIN_TOKEN in .env eintragen
openssl rand -hex 24   # -> als DEVICE_TOKEN in .env eintragen
docker compose up -d --build
curl http://localhost:8080/api/health    # -> {"ok":true,...}
```

Videos, Bilder und Datenbank liegen in `server/data/` → dieses Verzeichnis ins Proxmox-Backup aufnehmen.

### Vom Laden aus erreichbar machen

Die Demo-Geräte im Laden müssen deinen Server zu Hause über das Internet erreichen. Möglichkeiten:

1. **Cloudflare Tunnel (empfohlen)** – keine Portfreigabe am Router, automatisch HTTPS.
   Eigene Domain bei Cloudflare nötig. `cloudflared` im Container installieren, Tunnel auf
   `http://localhost:8080` zeigen lassen → Adresse z. B. `https://demo.deinedomain.de`.
2. **Reverse Proxy** (Nginx Proxy Manager / Caddy / Traefik) mit Let's-Encrypt-Zertifikat +
   Portfreigabe 443 am Router + DynDNS.
3. **Tailscale/WireGuard** – sehr sicher, aber dann muss auf jedem Demo-Gerät die VPN-App laufen.

> Bei Nginx: `client_max_body_size 2G;` setzen, sonst scheitern große Video-Uploads.
> Bei Cloudflare: Uploads im kostenlosen Tarif max. 100 MB pro Datei.

Die Tokens schützen den Server: Mit dem **DEVICE_TOKEN** kann man nur Inhalte abrufen; das
**ADMIN_TOKEN** gibt volle Kontrolle und gehört nur auf dein Handy.

---

## Webseite zur Verwaltung (am PC)

Der Server bringt eine Webseite mit: einfach die Server-Adresse im Browser öffnen
(z. B. `https://demo.deinedomain.de`). Dort kannst du:

- Videos und Bilder per **Drag & Drop** hochladen, mehrere gleichzeitig und auch große Videos
  (die Seite lädt in 20-MB-Stücken hoch, dadurch gilt die 100-MB-Grenze von Cloudflare nicht)
- neue Uploads direkt einer oder mehreren Playlists hinzufügen
- Medien ansehen, umbenennen, Anzeigedauer ändern, löschen
- Playlists anlegen, sortieren und bearbeiten
- sehen, welche Geräte online und aktuell sind

**Anmeldung einrichten:** Beim ersten Aufruf zeigt die Webseite eine **Ersteinrichtung**. Dort gibst du
einmal dein **Admin-Token** (`ADMIN_TOKEN` aus der `.env`, dasselbe wie in der Admin-App) ein und legst
Benutzername und Passwort fest. Über „Passwort vergessen?“ geht das jederzeit erneut, ebenfalls nur mit
dem Admin-Token. Angemeldet kannst du das Passwort oben rechts ändern.

Alternativ lassen sich die Zugangsdaten fest in `server/.env` eintragen (haben dann Vorrang):

```
WEB_USER=admin
WEB_PASSWORD=ein-langes-sicheres-passwort
```

Nach 5 Fehlversuchen wird die Anmeldung für 15 Minuten gesperrt. Die Anmeldung bleibt 14 Tage
gespeichert (Abmelden oben rechts). Passwörter werden nur verschlüsselt (als Hash) gespeichert.

## 2. Admin-App

1. `RetailDemo-Admin.apk` installieren („Installation aus unbekannten Quellen“ erlauben).
2. Tab **Einstellungen**: Server-Adresse + ADMIN_TOKEN → **Verbinden**.
3. Tab **Medien** → **Hinzufügen**: Videos/Bilder aus der Galerie wählen (Mehrfachauswahl).
4. Optional Tab **Playlists**: z. B. „Samsung“, „Apple“, „Xiaomi“ anlegen. Die mit ★ ist Standard.
5. Tab **Geräte**: Jedes Demo-Gerät erscheint automatisch. Antippen, um
   - einen schönen Namen zu vergeben (z. B. „Galaxy S25 Ultra 256 GB“),
   - eine Playlist zuzuweisen,
   - eigene Specs einzutragen (z. B. inkl. Preis) – sonst werden die automatisch erkannten gezeigt,
   - **Jetzt aktualisieren** auszulösen (wirkt innerhalb von ~5 Minuten statt erst nach einer Stunde).

   Geräte, die länger als 24 Std. offline sind, stehen eingeklappt unter „Länger als 24 Std. offline“
   und lassen sich dort gesammelt entfernen. Wird die Demo-App mit PIN deinstalliert, verschwindet das
   Gerät automatisch. Bei einer Neuinstallation erkennt der Server das Gerät wieder (Name, Playlist und
   Specs bleiben erhalten).

**Videoformat:** Am zuverlässigsten ist **MP4 mit H.264** (1080p). iPhone-Videos (.mov/HEVC)
laufen auf neueren Android-Geräten meist, auf älteren/günstigen eventuell nicht. Im Zweifel vorher
umwandeln, z. B. mit HandBrake oder `ffmpeg -i in.mov -c:v libx264 -crf 20 -an out.mp4`.

## 3. Demo-App auf einem Ausstellungsgerät

1. `RetailDemo-Demo.apk` installieren.
2. Beim ersten Start: Server-Adresse, DEVICE_TOKEN und eine PIN eintragen → **Speichern & synchronisieren**.
3. Berechtigungen auf derselben Seite erteilen:
   - **Bedienungshilfe** „Demo – Rückkehr nach Inaktivität“ einschalten
     (Android 13+: falls gesperrt → App-Info → ⋮ → „Eingeschränkte Einstellungen zulassen“),
   - **Über anderen Apps einblenden** (für Autostart nach Neustart),
   - **Akku-Optimierung** abschalten,
   - **Wecker und Erinnerungen** erlauben (Android 12+, für pünktliche Betriebszeiten),
   - **Zugriff auf alle Dateien** erlauben (zum Löschen der Kundenfotos).
4. Gerät: Displaysperre „Keine“, Bildschirm-Timeout auf Maximum, WLAN verbinden.
5. **Demo starten**.

**Verhalten:**
- Videos und Bilder laufen in Endlosschleife (Videos ohne Ton), nach jedem 3. Medium kommt die Seite mit Gerätename und Specs.
- Ein Kunde berührt den Bildschirm → Demo verschwindet, das Gerät ist normal benutzbar.
- 30 Sekunden ohne Bedienung → Demo startet automatisch wieder.
- Drückt jemand die Standby-Taste, geht das Display sofort wieder an und die Demo läuft weiter.
- **Betriebszeiten** (Admin-App → Einstellungen): pro Wochentag An-/Aus-Zeit. Außerhalb der Zeiten
  stoppt die Demo und das Display geht in Standby; zur Einschaltzeit weckt die App das Gerät wieder.
  (Ganz ausschalten kann eine App ein Handy ohne Root nicht – Standby verbraucht aber kaum Akku.)
- **Schutz:** Sprach-, Displaysperre-, PIN- und Passwort-Einstellungen werden sofort wieder geschlossen.
  Abschaltbar in den Einstellungen der Demo-App unter „Schutz für Vorführgeräte“.
- **Aufräumen** (Standard alle 2 Stunden, einstellbar in der Admin-App, 0 = aus): löscht alle Fotos,
  Videos und Screenshots (Ordner DCIM, Pictures, Movies) und setzt das Hintergrundbild zurück.
  Läuft nur, während die Demo spielt oder Ruhezeit ist – nie, während ein Kunde das Gerät benutzt.
  Manuell: Demo-Einstellungen → „Jetzt aufräumen“.
- **Helligkeit immer 100 %:** bei jedem Start der Demo (Erlaubnis „Systemeinstellungen ändern“ nötig).
- **Wecker sperren:** Die Uhr-App (Wecker, Timer, Stoppuhr) lässt sich nicht öffnen; klingelt trotzdem ein
  Wecker, drückt die App „Beenden“. Wecker anderer Apps löschen kann eine normale App unter Android nicht.
  Per Sprachassistent („Stell einen Wecker“) gestellte Wecker lassen sich so nicht verhindern, werden beim
  Klingeln aber beendet.
- **Deinstallieren nur mit PIN:** Der Deinstallieren-Dialog wird abgefangen und die Admin-PIN abgefragt.
  Alternativ in den Demo-Einstellungen → „App deinstallieren“.
  (Per USB/adb am PC lässt sich das ohne Root nicht verhindern.)
- Inhalte werden lokal gespeichert, die Demo läuft also auch bei einem WLAN-Ausfall weiter.
- 1× pro Stunde wird abgeglichen: Neues wird geladen, Gelöschtes entfernt.
- **Demo pausieren:** in den Demo-Einstellungen ganz oben „Demo pausieren“ (30 Min., 1 Std., 4 Std. oder bis
  „Fortsetzen“). Während der Pause ist das Gerät frei benutzbar: keine automatische Demo, keine Wecker-/Sprach-
  Sperre, kein Aufräumen. „Demo fortsetzen“ oder Tippen auf das Demo-Symbol startet die Demo wieder.
- **Zurück in die Einstellungen:** in der laufenden Demo **mit 3 Fingern oben rechts 3 Sekunden** gedrückt halten → PIN.

Alle Zeiten lassen sich in der Admin-App unter *Einstellungen → Demo-Verhalten* ändern.

---

## 4. Laptop-Demo (Mac und Windows)

**Mac** (macOS 12 oder neuer):

1. Passende Datei entpacken: `RetailDemo-Laptop-mac-arm64-….zip` für Macs mit Apple-Chip (M1–M5),
   `…-mac-x64-….zip` für ältere Intel-Macs. `Retail Demo Laptop.app` in den Ordner **Programme** ziehen.
2. Einmalig im Terminal (die App ist nicht bei Apple registriert, das signiert sie lokal):
   ```bash
   xattr -cr "/Applications/Retail Demo Laptop.app" && codesign --force --deep --sign - "/Applications/Retail Demo Laptop.app"
   ```
3. App öffnen. Sie hat kein Dock-Symbol, sondern ein Symbol oben in der **Menüleiste**.
4. Im Einrichtungsfenster Server-Adresse, **DEVICE_TOKEN** und eine PIN eintragen → **Speichern & verbinden**.
5. Optional **Kindersicherung → Einrichten** (fragt einmal das Admin-Passwort des Macs ab).
6. Systemeinstellungen → Sperrbildschirm: „Bildschirmschoner starten“ und „Display ausschalten“ auf **Nie**.
   Falls die App nach einem Neustart nicht startet: Systemeinstellungen → Allgemein → Anmeldeobjekte → „+“ → App hinzufügen.

**Windows:** `RetailDemo-Laptop-Setup-x.y.z.exe` ausführen (SmartScreen: „Weitere Informationen“ → „Trotzdem
ausführen“), dann weiter wie oben ab Schritt 4. Energieoptionen: Bildschirm ausschalten/Energiesparmodus bei Netzbetrieb auf **Nie**.

**Verhalten:**
- Niemand bedient den Laptop (Standard **60 Sekunden**, einstellbar unter Einstellungen → „Laden & Laptops“) →
  Vollbild-Präsentation: Logo-Intro, animierte Spec-Seite mit Preis, dann die Videos/Bilder der Playlist.
  Nach jedem n-ten Medium kommen Intro und Spec-Seite erneut.
- Maus bewegen, Touchpad, Taste → die Präsentation verschwindet sofort, der Laptop ist normal benutzbar.
- Während der Kunde den Laptop benutzt, hängt rechts am Bildschirmrand eine orange **„Specs“-Lasche**. Ein Klick
  klappt das Datenblatt auf (mit Knopf „Präsentation ansehen“).
- Specs werden automatisch erkannt (Prozessor, RAM, SSD, Grafik, Display, Akku, Windows-Version). Eigene Specs,
  Preis, Name und Playlist legst du wie bei den Handys auf der Webseite / in der Admin-App fest.
  Ein Eintrag mit der Bezeichnung „Preis“ wird groß als Preisschild gezeigt.
- **Laden-Logo** und **Ladenname**: Webseite → Einstellungen → „Laden & Laptops“ (oder Admin-App → Einstellungen).
- Betriebszeiten gelten auch für Laptops: außerhalb erscheint keine Demo, Windows darf in den Energiesparmodus.
- Mitarbeiter-Zugang: Symbol in der Menüleiste (Mac) bzw. im Tray unten rechts (Windows) → „Einstellungen …“ oder
  **⌃ ctrl + ⌥ option + ⇧ shift + D** (Windows: Strg + Alt + Umschalt + D), jeweils mit PIN. Beenden nur mit PIN.
  Startet automatisch beim Anmelden.

**Kindersicherung für Webseiten (Mac):** Webseite → Einstellungen → „Kindersicherung“ (oder Admin-App):
- *Jugendschutz*: Jugendschutz-DNS von Cloudflare for Families, sperrt Pornografie/Erwachsenen-Seiten und Schadsoftware.
- *Jugendschutz streng*: CleanBrowsing Family, zusätzlich Glücksspiel, Proxys/VPNs, SafeSearch bei Google/Bing/YouTube erzwungen.
- Eigene Sperrliste (z. B. `tiktok.com`), gilt bei eingeschalteter Kindersicherung.
- Gilt für alle Browser. Ein kleiner Systemdienst setzt die Einstellung und stellt sie alle 2 Minuten wieder her,
  falls jemand den DNS von Hand ändert. Ob sie aktiv ist, steht unter „Geräte“ beim jeweiligen Laptop.
- Grenzen: Wer im Browser selbst „Sicheres DNS“ mit einem anderen Anbieter einstellt oder ein VPN nutzt, kann den
  Filter umgehen (bei „streng“ sind die meisten VPN-Seiten gesperrt). Ausschalten: Einstellung auf „Aus“, oder in der
  Laptop-Demo → Einstellungen → Kindersicherung → Entfernen.

**Selbst bauen** (Node.js 22):

```bash
cd laptop
npm install
npm run dist:mac     # -> dist/RetailDemo-Laptop-mac-arm64-1.0.0.zip und …-mac-x64-1.0.0.zip
npm run dist:win     # -> dist/RetailDemo-Laptop-Setup-1.0.0.exe
```

Zum Ausprobieren ohne Installer: `npm start`. Für Updates in `laptop/package.json` die `version` erhöhen und die
neue Setup-Datei einfach über die alte installieren (Einstellungen bleiben erhalten).

## Übersicht

Webseite und Admin-App starten mit einer **Übersicht**: wie viele Geräte verbunden sind, auf wie vielen die
Demo gerade läuft (bzw. ein Kunde das Gerät benutzt, pausiert, Ruhezeit, offline), welche App-Versionen im
Einsatz sind und wie ausgelastet der Server-Container ist (CPU, RAM, Speicher, Verlauf der letzten Stunde).

Damit die Auslastung des **Proxmox-Containers** (und nicht nur die Docker-Sicht) angezeigt wird, bindet
`docker-compose.yml` drei Dateien aus `/proc` lesend ein – nach dem Update einmal
`docker compose up -d --build` ausführen.

## Apps aktualisieren (ohne neu einzurichten)

**Am einfachsten über den Server:** Webseite → Einstellungen → **App-Updates** → neue `RetailDemo-Demo-….apk`
hochladen → **„An alle Geräte verteilen“**. Alle Handys laden die neue Version innerhalb von ca. 5 Minuten
im Hintergrund herunter (die Demo läuft weiter). In der Geräteliste steht dann „⬇️ Update bereit“ – am
Gerät nur noch Demo-Einstellungen → **„Jetzt aktualisieren“** tippen. Ohne „Verteilen“ wird das Update
erst beim Tippen auf „Jetzt aktualisieren“ geladen. Auf jedem Gerät zeigen die Demo-Einstellungen unter „App-Version“ dann „Update verfügbar“ –
**„Jetzt aktualisieren“** tippen. Beim ersten Mal fragt Android nach der Erlaubnis „Unbekannte Apps
installieren“ und nach einer Bestätigung; danach (Android 12+) meist ohne Rückfrage.

**Oder von Hand:**

Neue Versionen einfach **über die alte installieren**: APK auf dem Gerät öffnen → „Aktualisieren“.
Server-Adresse, Token, PIN, Berechtigungen und Einstellungen bleiben erhalten.
**Die alte Version vorher nicht löschen!**

Das klappt nur, wenn die neue APK mit **demselben Signaturschlüssel** gebaut wurde
(`android/keystore/release.jks` + `android/keystore.properties`, siehe RetailDemo-Signaturschluessel.zip).
Ohne diesen Schlüssel bricht der Build absichtlich ab. In einer neuen Sitzung mit Claude die ZIP-Datei
deshalb immer mitgeben.

## APKs selbst bauen

```bash
cd android
./gradlew :admin:assembleRelease :demo:assembleRelease
# -> admin/build/outputs/apk/release/admin-release.apk
# -> demo/build/outputs/apk/release/demo-release.apk
```

**Wichtig:** `android/keystore/release.jks` + `android/keystore.properties` gut aufbewahren!
Updates der Apps lassen sich nur mit demselben Schlüssel über die alte Version installieren.
Für Updates in `*/build.gradle.kts` `versionCode` erhöhen.
