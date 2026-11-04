// Retail Demo Offline – Hauptprozess (Windows, ohne WLAN/Internet)
//
// - Startet mit Windows und geht sofort in den Vorführmodus (Präsentation wie in der Online-Version)
// - Inhalte (Videos, Bilder, Logo, Einstellungen) und neue Programmversionen kommen per USB-Stick:
//   Stick mit Ordner DEMO-UPDATE einstecken -> Ladebalken -> fertig, ohne Klick
// - Fährt den Laptop nach 9,5 Stunden (einstellbar) automatisch herunter
// Mitarbeiter: Tray-Symbol unten rechts oder Strg+Alt+Umschalt+D, jeweils mit PIN.
const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const { pathToFileURL } = require("url");
const { Stage, openWindow, asset, webPrefs } = require("../stage");
const { Content, VIDEO } = require("./content");
const usb = require("./usb");
const specs = require("../specs");

// Eigener Datenordner, unabhängig von der Online-Version
app.setPath("userData", path.join(app.getPath("appData"), "Retail Demo Offline"));
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("de.retaildemo.offline");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const SHUTDOWN_WARNING_S = 60;

let content, stage, tray, local = null;
let infoWin = null, pinWin = null, overlayWin = null;
let updating = false, handledStick = null, sessionStart = Date.now(), shuttingDown = false;

const fileUrl = (p, v) => pathToFileURL(p).href + (v ? `?v=${v}` : "");
const mtime = p => { try { return Math.round(fs.statSync(p).mtimeMs); } catch { return 0; } };

// ---------------------------------------------------------------- Daten für die Präsentation
function mergedSpecs() {
  const base = (local && local.specs) || [];
  const ov = local && content.deviceOverride(local);
  if (!ov) return base;
  const out = base.map(s => ({ ...s }));
  for (const s of ov.specs) {
    const same = out.find(x => x.label && x.label.toLowerCase() === s.label.toLowerCase());
    if (same) same.value = s.value; else out.push(s);
  }
  return out;
}

function viewModel() {
  const s = content.settings;
  const ov = local && content.deviceOverride(local);
  const logo = content.logoFile();
  return {
    items: content.items().map(it => ({ id: it.id, type: it.type, duration_s: it.duration_s, src: fileUrl(it.file, mtime(it.file)) })),
    display_name: (ov && ov.name) || (local && local.marketing_name) || "",
    manufacturer: (local && local.manufacturer) || "",
    specs: mergedSpecs(),
    show_specs: true,
    specs_every_n: s.specsEvery,
    specs_duration_s: s.specsS,
    store_name: s.storeName,
    welcome_prefix: true, // "Willkommen bei Expert Klein Asbach"
    logo: logo ? fileUrl(logo, mtime(logo)) : "",
  };
}

// ---------------------------------------------------------------- Overlay (Ladebalken, Herunterfahren)
function showOverlay(state) {
  if (!overlayWin) {
    overlayWin = new BrowserWindow({
      ...screen.getPrimaryDisplay().bounds, show: false, frame: false, skipTaskbar: true, alwaysOnTop: true,
      fullscreen: true, backgroundColor: "#0b0e14", webPreferences: webPrefs,
    });
    overlayWin.setAlwaysOnTop(true, "screen-saver");
    overlayWin.setMenu(null);
    overlayWin.on("close", e => { if (!stage.quitting) e.preventDefault(); });
    overlayWin.loadFile(asset("offline/overlay.html"));
    overlayWin.webContents.once("did-finish-load", () => overlayWin.showOverlayState && overlayWin.webContents.send("overlay", overlayWin.showOverlayState));
  }
  const vm = viewModel();
  overlayWin.showOverlayState = { logo: vm.logo, store_name: vm.store_name, ...state };
  if (!overlayWin.webContents.isLoading()) overlayWin.webContents.send("overlay", overlayWin.showOverlayState);
  if (!overlayWin.isVisible()) { overlayWin.show(); overlayWin.focus(); }
}

function hideOverlay() {
  if (overlayWin && overlayWin.isVisible()) overlayWin.hide();
  stage.lastIdle = 0;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- USB-Update
async function checkStick() {
  if (updating || shuttingDown) return;
  const dir = await usb.findStick();
  if (!dir) { handledStick = null; return; }
  if (dir === handledStick) return; // Stick steckt noch -> erst nach Abziehen erneut prüfen
  handledStick = dir;
  updating = true;
  try {
    await runStickUpdate(dir);
  } finally {
    updating = false;
  }
}

async function runStickUpdate(dir) {
  const info = await usb.inspect(dir, app.getVersion());
  if (!info.keyOk) {
    showOverlay({ kind: "error", title: "Kein gültiger Update-Stick", text: `Die Datei ${usb.KEY_FILE} im Ordner ${usb.MARKER} fehlt oder ist falsch.`, hint: "" });
    await wait(6000);
    return hideOverlay();
  }
  await usb.reportDevice(dir, local);
  const newContent = (info.media.length || info.logo || info.extras.length) && info.fingerprint !== content.state.lastFingerprint;
  if (!newContent && !info.setup) return; // schon übernommen

  stage.hideDemo();
  try {
    if (newContent) {
      showOverlay({ kind: "busy", title: "Demo wird aktualisiert", text: "Dateien werden kopiert …", progress: 0, hint: "USB-Stick bitte nicht entfernen" });
      let last = 0;
      await usb.applyContent(info, content.dir, content.mediaDir, (p, text) => {
        // Anzeige höchstens ~10× pro Sekunde aktualisieren
        if (Date.now() - last < 100 && p < 1) return;
        last = Date.now();
        showOverlay({ kind: "busy", title: "Demo wird aktualisiert", text, progress: p, hint: "USB-Stick bitte nicht entfernen" });
      });
      content.reload();
      content.saveState({ lastFingerprint: info.fingerprint, lastUpdate: Date.now() });
      stage.pushViewModel();
    }
    if (info.setup) return await installSetup(info.setup);
    const n = info.media.length;
    const text = n ? `${n} ${n === 1 ? "Video/Bild" : "Videos/Bilder"} übernommen` : "Einstellungen übernommen";
    showOverlay({ kind: "done", title: "Update abgeschlossen", text, hint: "Der USB-Stick kann jetzt entfernt werden" });
    await wait(5000);
  } catch (e) {
    console.warn("USB-Update:", e);
    showOverlay({ kind: "error", title: "Update abgebrochen", text: "Die bisherigen Inhalte bleiben erhalten.", hint: "Stick abziehen und erneut einstecken" });
    await wait(8000);
  }
  hideOverlay();
  stage.showDemo();
}

async function installSetup(setup) {
  const attempt = `${setup.version}|${setup.size}`;
  if (content.state.setupAttempt === attempt) {
    // Wurde schon versucht und läuft trotzdem noch die alte Version -> nicht in Dauerschleife installieren
    showOverlay({ kind: "error", title: "Programm-Update fehlgeschlagen", text: `Version ${setup.version} konnte nicht installiert werden.`, hint: "Bitte die Setup-Datei einmal von Hand starten" });
    await wait(8000);
    hideOverlay();
    return stage.showDemo();
  }
  showOverlay({ kind: "busy", title: "Neue Programmversion", text: `Version ${setup.version} wird vorbereitet …`, progress: 0, hint: "USB-Stick bitte nicht entfernen" });
  const exe = await usb.stageSetup(setup, (p, text) => showOverlay({ kind: "busy", title: "Neue Programmversion", text, progress: p, hint: "USB-Stick bitte nicht entfernen" }));
  // Die laufende Einschaltzeit mitnehmen, damit das Herunterfahren nicht neu zu zählen beginnt
  content.saveState({ setupAttempt: attempt, carrySessionStart: sessionStart });
  showOverlay({ kind: "busy", title: "Neue Programmversion", text: `Version ${setup.version} wird installiert – die Demo startet gleich neu`, progress: null, hint: "Der USB-Stick kann jetzt entfernt werden" });
  await wait(1500);
  if (process.platform !== "win32") {
    console.log(`[Test] würde installieren: ${exe} /S --force-run`);
    return;
  }
  // Stille Installation (/S), danach startet der Installer die neue Version (--force-run)
  spawn(exe, ["/S", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  stage.quitting = true;
  setTimeout(() => app.exit(0), 300);
}

// ---------------------------------------------------------------- Herunterfahren nach x Stunden
function shutdownAt() {
  const h = content.settings.shutdownH;
  return h > 0 ? sessionStart + h * 3600_000 : 0;
}

async function checkShutdown() {
  const at = shutdownAt();
  if (!at || Date.now() < at || shuttingDown || updating) return;
  shuttingDown = true;
  stage.hideDemo();
  for (let s = SHUTDOWN_WARNING_S; s > 0; s--) {
    showOverlay({ kind: "shutdown", title: "Feierabend!", text: `Der Laptop wird in ${s} Sekunden heruntergefahren.`, progress: s / SHUTDOWN_WARNING_S, hint: "" });
    await wait(1000);
  }
  if (process.env.RD_DRY_SHUTDOWN || !app.isPackaged) {
    console.log("[Test] würde jetzt herunterfahren");
    return;
  }
  const cmd = { win32: ["shutdown", ["/s", "/f", "/t", "0"]], darwin: ["osascript", ["-e", 'tell app "System Events" to shut down']] }[process.platform]
    || ["systemctl", ["poweroff"]];
  execFile(cmd[0], cmd[1], { windowsHide: true }, err => { if (err) console.warn("Herunterfahren fehlgeschlagen:", err.message); });
}

// ---------------------------------------------------------------- Mitarbeiter: PIN, Info, Tray
function withPin(then) {
  if (pinWin) return pinWin.focus();
  stage.hideDemo();
  pinWin = openWindow("pin.html", { width: 380, height: 300, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true, title: "PIN" });
  pinWin.setAlwaysOnTop(true, "screen-saver");
  pinWin.pinThen = then;
  pinWin.on("closed", () => { pinWin = null; stage.lastIdle = 0; });
}

function openInfo() {
  if (infoWin) return infoWin.focus();
  infoWin = openWindow("offline/info.html", { width: 560, height: 700, title: "Retail Demo Offline – Info", alwaysOnTop: true });
  infoWin.on("closed", () => { infoWin = null; stage.lastIdle = 0; });
}

function quit() {
  stage.quitting = true;
  app.quit();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Retail Demo Offline – ${stage.status || "Start"}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${stage.status || "…"}`, enabled: false },
    { type: "separator" },
    { label: "Demo jetzt starten", click: () => stage.showDemo() },
    { label: "Info …", click: () => withPin(openInfo) },
    { type: "separator" },
    { label: "Beenden …", click: () => withPin(quit) },
  ]));
}

ipcMain.handle("pin:check", (e, pin) => {
  if (String(pin) !== content.settings.pin) return false;
  const w = BrowserWindow.fromWebContents(e.sender);
  const then = w && w.pinThen;
  if (w) { w.pinThen = null; w.close(); }
  if (then) setTimeout(then, 50);
  return true;
});

ipcMain.handle("info:get", () => {
  const items = content.items();
  const vm = viewModel();
  return {
    version: app.getVersion(),
    videos: items.filter(i => VIDEO.test(i.id)).length,
    images: items.filter(i => !VIDEO.test(i.id)).length,
    hasLogo: !!content.logoFile(),
    storeName: content.settings.storeName,
    lastUpdate: content.state.lastUpdate || 0,
    idleS: content.settings.idleS,
    shutdownAt: shutdownAt(),
    local,
    displayName: vm.display_name,
    override: !!(local && content.deviceOverride(local)),
    specs: vm.specs,
  };
});
ipcMain.on("info:startDemo", () => { if (infoWin) infoWin.close(); setTimeout(() => stage.showDemo(), 300); });
ipcMain.on("info:quit", () => quit());

// ---------------------------------------------------------------- Start
app.on("second-instance", () => stage && stage.showDemo());
app.on("window-all-closed", () => { /* läuft im Hintergrund weiter */ });
app.on("before-quit", e => { if (!stage || !stage.quitting) e.preventDefault(); });

app.whenReady().then(async () => {
  content = new Content(path.join(app.getPath("userData"), "inhalt"));

  // Nach einem Programm-Update läuft die Einschaltzeit weiter
  const carry = content.state.carrySessionStart;
  if (carry && Date.now() - carry < content.settings.shutdownH * 3600_000) sessionStart = carry;
  content.saveState({ carrySessionStart: null });
  if (content.state.setupAttempt && usb.versionNum(content.state.setupAttempt.split("|")[0]) <= usb.versionNum(app.getVersion())) {
    content.saveState({ setupAttempt: null }); // Update hat geklappt
  }

  stage = new Stage({
    viewModel,
    idleTimeout: () => content.settings.idleS,
    isActive: () => true,
    isBusy: () => updating || shuttingDown || !!pinWin || !!infoWin,
    onStatus: updateTray,
  });

  const img = nativeImage.createFromPath(path.join(__dirname, "..", "..", "build", "icon.png"));
  tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
  tray.on("click", () => tray.popUpContextMenu());
  updateTray();

  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  globalShortcut.register("Control+Alt+Shift+D", () => withPin(openInfo));

  stage.start();
  // Vorführmodus direkt nach dem Start
  stage.demoWin.webContents.once("did-finish-load", () => setTimeout(() => stage.showDemo(), 500));

  // Hardware einmal auslesen (dauert unter Windows ein paar Sekunden)
  specs.collect().then(l => { local = l; stage.restartDemo(); }).catch(e => console.warn("Specs:", e));

  const loop = async (fn, ms) => { try { await fn(); } catch (e) { console.warn(e); } setTimeout(() => loop(fn, ms), ms); };
  setTimeout(() => loop(checkStick, 3000), 2000);
  loop(checkShutdown, 15_000);
});

app.on("will-quit", () => globalShortcut.unregisterAll());
