// Inhalte der Offline-Demo: Videos/Bilder, Logo und die optionalen Textdateien vom USB-Stick.
// Alles liegt in %APPDATA%/Retail Demo Offline/inhalt/ und wird nur per USB-Stick ersetzt.
const fs = require("fs");
const path = require("path");

const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const LOGO = /^logo\.(png|svg|jpe?g|webp)$/i;
const SETTINGS_FILE = "einstellungen.txt";
// helle Fassung für den dunklen Hintergrund der Präsentation
const DEFAULT_LOGO = path.join(__dirname, "logo-standard.svg");
const DEVICES_FILE = "geraete.txt";

const DEFAULTS = {
  storeName: "Expert Klein Asbach",
  idleS: 60,            // Präsentation startet nach … Sekunden ohne Bedienung
  shutdownH: 9.5,       // Laptop fährt nach … Stunden herunter (0 = nie)
  pin: "1234",          // Mitarbeiter-PIN für Info/Beenden
  imageS: 8,            // Bilder werden … Sekunden gezeigt
  specsEvery: 3,        // Spec-Seite nach jedem … Video/Bild
  specsS: 12,           // Spec-Seite dauert … Sekunden
};

const isMedia = name => !name.startsWith(".") && !name.startsWith("._") && !LOGO.test(name) && (VIDEO.test(name) || IMAGE.test(name));
const naturalSort = (a, b) => a.localeCompare(b, "de", { numeric: true, sensitivity: "base" });
const num = v => parseFloat(String(v).replace(",", "."));

/**
 * einstellungen.txt, z. B.
 *   Ladenname = Expert Klein Asbach
 *   Demo startet nach (Sekunden) = 60
 *   Herunterfahren nach (Stunden) = 9,5
 */
const THEMES = ["standard", "blackweek", "weihnachten", "geburtstag", "sonderangebot"];
/** "Black Week" / "Weihnachten" / "Geburtstag" / "Sonderangebot" / "Standard" -> interner Name (unbekannt = undefined) */
function themeName(v) {
  const s = v.toLowerCase();
  if (/black|bw/.test(s)) return "blackweek";
  if (/weihnacht|xmas|christ|advent/.test(s)) return "weihnachten";
  if (/geburt|birthday|jubil/.test(s)) return "geburtstag";
  if (/sonder|abverkauf|sale|raus|restposten/.test(s)) return "sonderangebot";
  if (/standard|normal|aus/.test(s)) return "standard";
  return undefined;
}

function parseSettings(text) {
  const s = { ...DEFAULTS };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(.+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (/theme|thema|design/.test(key)) s.theme = themeName(val);
    else if (/laden|name/.test(key)) s.storeName = val;
    else if (/herunter|ausschalten|shutdown/.test(key) && num(val) >= 0) s.shutdownH = num(val);
    else if (/demo startet|leerlauf|warte/.test(key) && num(val) >= 5) s.idleS = Math.round(num(val));
    else if (/pin/.test(key) && /^\d{4,8}$/.test(val)) s.pin = val;
    else if (/spec.*(nach|jede)/.test(key) && num(val) >= 1) s.specsEvery = Math.round(num(val));
    else if (/spec.*(dauer|sekunden)/.test(key) && num(val) >= 4) s.specsS = Math.round(num(val));
    else if (/bild/.test(key) && num(val) >= 1) s.imageS = Math.round(num(val));
  }
  return s;
}

/**
 * geraete.txt: eine Zeile pro Modell, Teile mit | getrennt
 *   750QHA | Samsung Galaxy Book5 360 | Preis: 899 € | Farbe: Grau
 * 1. Teil = Modell-Code (steht in erkannte-geraete.txt auf dem Stick), 2. Teil = Name (leer = automatisch),
 * danach beliebige Specs "Bezeichnung: Wert" (gleiche Bezeichnung ersetzt den erkannten Wert).
 */
function parseDevices(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map(p => p.trim());
    if (!parts[0]) continue;
    const specs = parts.slice(2).filter(Boolean).map(p => {
      const i = p.indexOf(":");
      return i > 0 ? { label: p.slice(0, i).trim(), value: p.slice(i + 1).trim() } : { label: "", value: p };
    });
    out.push({ code: parts[0].toLowerCase(), name: parts[1] || "", specs });
  }
  return out;
}

class Content {
  constructor(dir) {
    this.dir = dir;
    this.mediaDir = path.join(dir, "medien");
    this.stateFile = path.join(dir, "status.json");
    fs.mkdirSync(this.mediaDir, { recursive: true });
    // Status lesen; ist die Datei beschädigt (z. B. Strom weg beim Schreiben), die Sicherung nehmen
    this.state = {};
    for (const f of [this.stateFile, this.stateFile + ".bak"]) {
      try { this.state = JSON.parse(fs.readFileSync(f, "utf8")); break; } catch {}
    }
    this.reload();
  }

  reload() {
    const read = f => { try { return fs.readFileSync(path.join(this.dir, f), "utf8"); } catch { return ""; } };
    this.settings = parseSettings(read(SETTINGS_FILE));
    this.devices = parseDevices(read(DEVICES_FILE));
  }

  /** Sicher speichern: erst Zwischendatei schreiben und auf die Platte zwingen, dann umbenennen. */
  saveState(values) {
    Object.assign(this.state, values);
    const tmp = this.stateFile + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try { fs.writeSync(fd, JSON.stringify(this.state, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.copyFileSync(this.stateFile, this.stateFile + ".bak"); } catch {}
    fs.renameSync(tmp, this.stateFile);
  }

  /** Alle Videos/Bilder: reguläre und wöchentliche Werbung (abgespielt wird zufällig gemischt). */
  items() {
    const out = [];
    // "" = Inhalte älterer Versionen direkt in medien/ (zählen als regulär)
    for (const [group, sub] of [["regulaer", ""], ["regulaer", "regulaer"], ["woechentlich", "woechentlich"]]) {
      let names = [];
      try { names = fs.readdirSync(path.join(this.mediaDir, sub)).filter(isMedia).sort(naturalSort); } catch {}
      for (const name of names) {
        out.push({
          id: sub ? `${sub}/${name}` : name,
          group,
          type: VIDEO.test(name) ? "video" : "image",
          duration_s: this.settings.imageS,
          file: path.join(this.mediaDir, sub, name),
        });
      }
    }
    return out;
  }

  /** Logo vom USB-Stick, sonst das mitgelieferte expert-klein-Logo. */
  logoFile() {
    try {
      const f = fs.readdirSync(this.dir).find(n => LOGO.test(n));
      if (f) return path.join(this.dir, f);
    } catch {}
    return DEFAULT_LOGO;
  }

  hasOwnLogo() { return this.logoFile() !== DEFAULT_LOGO; }

  /** Passende Zeile aus geraete.txt für diesen Laptop. */
  deviceOverride(local) {
    const ids = [local.model, local.sku, local.marketing_name].filter(Boolean).map(v => v.toLowerCase());
    return this.devices.find(d => ids.some(id => id === d.code || id.startsWith(d.code) || (d.code.length >= 4 && id.includes(d.code)))) || null;
  }
}

module.exports = { Content, THEMES, themeName, parseSettings, parseDevices, isMedia, VIDEO, IMAGE, LOGO, SETTINGS_FILE, DEVICES_FILE, DEFAULTS, naturalSort };
