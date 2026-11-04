// USB-Stick-Update: Steckt ein Stick mit dem Ordner DEMO-UPDATE (und gültiger Schlüsseldatei),
// werden ohne Klick
//   - alle Videos/Bilder ersetzt (nur wenn auf dem Stick welche liegen)
//   - Logo, einstellungen.txt und geraete.txt übernommen (falls vorhanden)
//   - eine neuere Programmversion (RetailDemo-Offline-Setup-x.y.z.exe) still installiert
// Ohne die Schlüsseldatei passiert nichts – so kann kein fremder Stick Inhalte oder Programme einschleusen.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { isMedia, LOGO, SETTINGS_FILE, DEVICES_FILE } = require("./content");

const MARKER = "DEMO-UPDATE";
const KEY_FILE = "demo-schluessel.txt";
const REPORT_FILE = "erkannte-geraete.txt";
// SHA-256 des Schlüssels auf dem Stick (der Schlüssel selbst steht nicht im Programm)
const KEY_HASH = "4ddbcaef75233a3cc42d6e624d27ecc370d3ad7ab54b64920a2441b83b03b5fc";
const SETUP_RE = /^RetailDemo-Offline-Setup-(\d+)\.(\d+)\.(\d+)\.exe$/i;

/** Mögliche Stick-Laufwerke. Zum Testen per RD_USB_ROOTS (Pfade mit ; oder : getrennt) vorgebbar. */
function candidateRoots() {
  if (process.env.RD_USB_ROOTS) return process.env.RD_USB_ROOTS.split(path.delimiter).filter(Boolean);
  if (process.platform === "win32") {
    // C: ist die Systemplatte; A:/B: sind historisch Diskettenlaufwerke
    return "DEFGHIJKLMNOPQRSTUVWXYZ".split("").map(l => `${l}:\\`);
  }
  const roots = [];
  for (const base of process.platform === "darwin" ? ["/Volumes"] : ["/media", "/run/media", "/mnt"]) {
    try {
      for (const a of fs.readdirSync(base)) {
        const p = path.join(base, a);
        roots.push(p);
        try { for (const b of fs.readdirSync(p)) roots.push(path.join(p, b)); } catch {}
      }
    } catch {}
  }
  return roots;
}

async function findStick() {
  for (const root of candidateRoots()) {
    const dir = path.join(root, MARKER);
    try { if ((await fsp.stat(dir)).isDirectory()) return dir; } catch {}
  }
  return null;
}

/** Beginnt die Datei wie ein Windows-Programm ("MZ") und ist plausibel groß? */
async function isWindowsProgram(file) {
  try {
    const fh = await fsp.open(file, "r");
    try {
      const { size } = await fh.stat();
      const buf = Buffer.alloc(2);
      await fh.read(buf, 0, 2, 0);
      return size > 10 * 1024 * 1024 && buf.toString("latin1") === "MZ";
    } finally { await fh.close(); }
  } catch { return false; }
}

function versionNum(v) { return v.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0); }

/** Inhalt des Stick-Ordners prüfen und einordnen. */
async function inspect(dir, appVersion) {
  const names = await fsp.readdir(dir);
  const file = n => path.join(dir, n);
  let keyOk = false;
  try {
    const key = (await fsp.readFile(file(KEY_FILE), "utf8")).trim();
    keyOk = crypto.createHash("sha256").update(key).digest("hex") === KEY_HASH;
  } catch {}

  const stat = async n => { try { const s = await fsp.stat(file(n)); return s.isFile() ? s : null; } catch { return null; } };
  const entries = [];
  for (const n of names) {
    const s = await stat(n);
    if (s) entries.push({ name: n, size: s.size, mtime: s.mtimeMs, path: file(n) });
  }
  const media = entries.filter(e => isMedia(e.name));
  const logo = entries.find(e => LOGO.test(e.name)) || null;
  const extras = entries.filter(e => [SETTINGS_FILE, DEVICES_FILE].includes(e.name.toLowerCase()));
  // Neueste Programmversion auf dem Stick, nur wenn neuer als die installierte
  let setup = null;
  for (const e of entries) {
    const m = SETUP_RE.exec(e.name);
    if (!m) continue;
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    if (!(await isWindowsProgram(e.path))) continue; // kaputte/unvollständige Datei nicht installieren
    if (versionNum(version) > versionNum(appVersion) && (!setup || versionNum(version) > versionNum(setup.version))) setup = { ...e, version };
  }
  // Fingerabdruck: gleicher Stick-Inhalt wird nur einmal übernommen
  const relevant = [...media, ...extras, ...(logo ? [logo] : [])];
  const fingerprint = crypto.createHash("sha256")
    .update(relevant.map(e => `${e.name}|${e.size}|${Math.round(e.mtime)}`).sort().join("\n")).digest("hex");
  return { dir, keyOk, media, logo, extras, setup, fingerprint };
}

/** Datei kopieren und dabei den Fortschritt (Bytes) melden. */
function copyWithProgress(src, dest, onBytes) {
  return new Promise((resolve, reject) => {
    const r = fs.createReadStream(src, { highWaterMark: 1024 * 1024 });
    const w = fs.createWriteStream(dest);
    r.on("data", c => onBytes(c.length));
    r.on("error", reject);
    w.on("error", reject);
    w.on("finish", resolve);
    r.pipe(w);
  });
}

/**
 * Stick-Inhalt übernehmen. Erst alles in einen Zwischenordner kopieren, dann austauschen –
 * wird der Stick mittendrin abgezogen, bleiben die alten Inhalte vollständig erhalten.
 * @param onProgress (anteil 0..1, text)
 */
async function applyContent(info, contentDir, mediaDir, onProgress) {
  const total = info.media.reduce((a, e) => a + e.size, 0) + (info.logo ? info.logo.size : 0) || 1;
  let done = 0;
  const tick = (n, label) => { done += n; onProgress(Math.min(done / total, 1), label); };

  const staging = mediaDir + ".neu";
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  if (info.media.length) {
    for (const [i, e] of info.media.entries()) {
      const label = `Datei ${i + 1} von ${info.media.length}: ${e.name}`;
      onProgress(done / total, label);
      await copyWithProgress(e.path, path.join(staging, e.name), n => tick(n, label));
    }
  }
  let logoTmp = null;
  if (info.logo) {
    logoTmp = path.join(contentDir, "logo.neu");
    await copyWithProgress(info.logo.path, logoTmp, n => tick(n, "Logo"));
  }
  const extraData = [];
  for (const e of info.extras) extraData.push([e.name.toLowerCase(), await fsp.readFile(e.path)]);

  // Ab hier nur noch schnelle Operationen auf der eigenen Platte
  if (info.media.length) {
    const old = mediaDir + ".alt";
    await fsp.rm(old, { recursive: true, force: true });
    if (fs.existsSync(mediaDir)) await fsp.rename(mediaDir, old);
    await fsp.rename(staging, mediaDir);
    await fsp.rm(old, { recursive: true, force: true });
  } else {
    await fsp.rm(staging, { recursive: true, force: true });
  }
  if (logoTmp) {
    for (const n of await fsp.readdir(contentDir)) if (LOGO.test(n)) await fsp.rm(path.join(contentDir, n), { force: true });
    await fsp.rename(logoTmp, path.join(contentDir, info.logo.name.toLowerCase()));
  }
  for (const [name, data] of extraData) await fsp.writeFile(path.join(contentDir, name), data);
  onProgress(1, "Fertig");
}

/** Programm-Update vom Stick in den Temp-Ordner kopieren (der Stick darf danach abgezogen werden). */
async function stageSetup(setup, onProgress) {
  const dest = path.join(os.tmpdir(), setup.name);
  let done = 0;
  await copyWithProgress(setup.path, dest, n => { done += n; onProgress(done / setup.size, `Version ${setup.version} wird vorbereitet …`); });
  return dest;
}

/**
 * Trägt diesen Laptop in erkannte-geraete.txt auf dem Stick ein. Daraus kopiert man die
 * Zeile in geraete.txt, um Name oder Preis festzulegen.
 */
async function reportDevice(dir, local) {
  if (!local || !local.model) return;
  const f = path.join(dir, REPORT_FILE);
  let text = "";
  try { text = await fsp.readFile(f, "utf8"); } catch {
    text = "# Von den Demo-Laptops automatisch erkannt. Zeilen nach geraete.txt kopieren und anpassen,\n"
      + "# z. B. Name korrigieren oder \"| Preis: 999 €\" anhängen.\n";
  }
  const code = local.model;
  if (text.split(/\r?\n/).some(l => l.split("|")[0].trim().toLowerCase() === code.toLowerCase())) return;
  text += `${code} | ${local.marketing_name}\n`;
  await fsp.writeFile(f, text).catch(() => {}); // schreibgeschützter Stick: egal
}

module.exports = { MARKER, KEY_FILE, findStick, inspect, applyContent, stageSetup, reportDevice, SETUP_RE, versionNum };
