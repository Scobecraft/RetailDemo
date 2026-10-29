// Kindersicherung für Webseiten (nur macOS).
// Die App selbst hat keine Admin-Rechte. Einmalig (mit Admin-Passwort) wird ein kleiner Systemdienst
// installiert (mac/webfilter.sh), der Jugendschutz-DNS und Sperrliste setzt. Danach schreibt die App
// nur noch die Konfiguration, die auf der Webseite / in der Admin-App eingestellt wird.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const SUPPORTED = process.platform === "darwin";
const DIR = "/Library/Application Support/RetailDemo";
const SCRIPT = `${DIR}/webfilter.sh`;
const CONF = `${DIR}/webfilter.conf`;
const STATUS = `${DIR}/webfilter.status`;
const PLIST = "/Library/LaunchDaemons/de.retaildemo.webfilter.plist";
const LABEL = "de.retaildemo.webfilter";
const SCRIPT_VERSION = "# version 1";

const MODES = { family: "Jugendschutz", strict: "Jugendschutz streng" };

function installed() {
  if (!SUPPORTED) return false;
  try { return fs.existsSync(PLIST) && fs.readFileSync(SCRIPT, "utf8").includes(SCRIPT_VERSION); } catch { return false; }
}

/** Gewünschte Einstellung aus dem Manifest an den Systemdienst weitergeben. */
function apply(manifest) {
  if (!SUPPORTED || !installed() || !manifest) return;
  const mode = MODES[manifest.web_filter] ? manifest.web_filter : "off";
  const text = [mode, ...(manifest.blocked_domains || [])].join("\n") + "\n";
  try {
    if (fs.readFileSync(CONF, "utf8") !== text) fs.writeFileSync(CONF, text);
  } catch (e) { console.warn("Kindersicherung:", e.message); }
}

/** Kurzer Zustand für Status-Anzeigen; leer, wenn die Kindersicherung nicht gewünscht ist. */
function describe(manifest) {
  const wanted = manifest && MODES[manifest.web_filter];
  if (!wanted) return "";
  if (!SUPPORTED) return "Kindersicherung nur auf dem Mac verfügbar";
  if (!installed()) return "⚠ Kindersicherung am Laptop noch nicht eingerichtet";
  try {
    const [mode, ts] = fs.readFileSync(STATUS, "utf8").trim().split(" ");
    if (mode === manifest.web_filter && Date.now() / 1000 - Number(ts) < 600) return `${wanted} aktiv`;
  } catch {}
  return `${wanted} wird aktiviert …`;
}

// AppleScript "with administrator privileges" zeigt den normalen macOS-Passwortdialog
function runAsAdmin(shell, prompt) {
  const esc = s => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `do shell script "${esc(shell)}" with administrator privileges with prompt "${esc(prompt)}"`;
  return new Promise((resolve, reject) => execFile("/usr/bin/osascript", ["-e", script], { timeout: 120_000 }, (err, _out, stderr) => {
    if (!err) return resolve();
    reject(new Error(/-128|abgebrochen|cancel/i.test(String(stderr)) ? "Abgebrochen" : String(stderr || err.message).trim()));
  }));
}

const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;

async function install() {
  if (!SUPPORTED) throw new Error("Nur auf dem Mac verfügbar");
  const user = os.userInfo().username;
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error("Unerwarteter Benutzername");
  // Dateien liegen im App-Archiv (asar) -> erst in einen Temp-Ordner kopieren
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retaildemo-"));
  fs.writeFileSync(path.join(tmp, "webfilter.sh"), fs.readFileSync(path.join(__dirname, "mac", "webfilter.sh")));
  fs.writeFileSync(path.join(tmp, "webfilter.plist"), fs.readFileSync(path.join(__dirname, "mac", "de.retaildemo.webfilter.plist")));
  const shell = [
    "set -e",
    `mkdir -p ${q(DIR)}`,
    `chown root:wheel ${q(DIR)}`,
    `chmod 755 ${q(DIR)}`,
    `install -o root -g wheel -m 755 ${q(path.join(tmp, "webfilter.sh"))} ${q(SCRIPT)}`,
    `install -o root -g wheel -m 644 ${q(path.join(tmp, "webfilter.plist"))} ${q(PLIST)}`,
    // Konfiguration darf die App (ohne Admin) schreiben
    `[ -f ${q(CONF)} ] || echo off > ${q(CONF)}`,
    `chown ${user} ${q(CONF)}`,
    `chmod 644 ${q(CONF)}`,
    `launchctl bootout system/${LABEL} 2>/dev/null || true`,
    `launchctl bootstrap system ${q(PLIST)}`,
  ].join(" && ");
  try {
    await runAsAdmin(shell, "Retail Demo möchte die Kindersicherung für Webseiten einrichten.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function uninstall() {
  if (!SUPPORTED || !installed()) return;
  const shell = [
    // Einmal mit "aus" laufen lassen: DNS und /etc/hosts zurücksetzen
    `echo off > ${q(CONF)}`,
    `/bin/bash ${q(SCRIPT)}`,
    `launchctl bootout system/${LABEL} 2>/dev/null || true`,
    `rm -f ${q(PLIST)}`,
    `rm -rf ${q(DIR)}`,
  ].join(" ; ");
  await runAsAdmin(shell, "Retail Demo möchte die Kindersicherung entfernen.");
}

module.exports = { SUPPORTED, installed, apply, describe, install, uninstall };
