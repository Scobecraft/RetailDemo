// Retail Demo Laptop – Hauptprozess
//
// Ablauf wie bei Intel iPOS / AMD Advance:
// - Niemand benutzt den Laptop (Standard 60 s) -> Vollbild-Präsentation mit Logo, animierten Specs und Videos
// - Kunde bewegt Maus / tippt -> Präsentation verschwindet sofort, Laptop ist normal benutzbar
// - Während der Kunde den Laptop benutzt, hängt rechts am Bildschirmrand eine kleine "Specs"-Lasche,
//   die sich zu einem Datenblatt aufklappen lässt
// Einstellungen: Tray-Symbol (Windows: unten rechts, Mac: Menüleiste) oder Strg+Alt+Umschalt+D
// (Mac: ⌃⌥⇧D), jeweils mit PIN.
const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const { Config, normalizeUrl } = require("./config");
const { Sync } = require("./sync");
const { isActiveAt } = require("./schedule");
const { Stage, openWindow, IS_MAC } = require("./stage");
const filter = require("./filter");
const { rate } = require("./suitability");

if (!app.requestSingleInstanceLock()) app.quit();

app.setAppUserModelId("de.retaildemo.laptop");
// Videos sollen ohne vorherigen Klick starten
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const DEFAULT_IDLE_S = 60;

let config, sync, tray, stage;
let setupWin = null, pinWin = null;

const fileUrl = (p, v) => pathToFileURL(p).href + (v ? `?v=${v}` : "");

// ---------------------------------------------------------------- Daten für die Oberflächen
function viewModel() {
  const m = sync.manifest || {};
  const local = sync.local || { specs: [] };
  const items = (m.items || []).filter(it => sync.isAvailable(it)).map(it => ({
    id: it.id, type: it.type, duration_s: it.duration_s, src: fileUrl(sync.localFile(it)),
  }));
  const logo = sync.logoFile(m);
  const rated = rate(m.specs && m.specs.length ? m.specs : local.specs, local.specs);
  return {
    items,
    display_name: m.display_name || local.marketing_name || "",
    manufacturer: m.manufacturer || local.manufacturer || "",
    specs: rated.specs,
    suitability: rated.suitability,
    show_specs: m.show_specs !== false,
    specs_every_n: m.specs_every_n || 3,
    specs_duration_s: Math.max(8, m.specs_duration_s || 12),
    store_name: m.store_name || "",
    logo: logo && require("fs").existsSync(logo) ? fileUrl(logo, m.logo_sha256.slice(0, 8)) : "",
  };
}

// ---------------------------------------------------------------- Fenster
function openSetup() {
  if (setupWin) return setupWin.focus();
  stage.hideDemo();
  setupWin = openWindow("setup.html", { width: 620, height: 820, minWidth: 520, title: "Retail Demo Laptop – Einstellungen", alwaysOnTop: true });
  setupWin.on("closed", () => { setupWin = null; stage.lastIdle = 0; });
}

/** Fragt die PIN ab und ruft danach [then] auf. Ohne festgelegte PIN direkt weiter. */
function withPin(then) {
  if (!config.data.pinHash) return then();
  if (pinWin) return pinWin.focus();
  stage.hideDemo();
  pinWin = openWindow("pin.html", { width: 380, height: 300, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true, title: "PIN" });
  pinWin.setAlwaysOnTop(true, "screen-saver");
  pinWin.pinThen = then;
  pinWin.on("closed", () => { pinWin = null; });
}

// Statusänderung kurz danach sofort melden, damit die Übersicht auf der Webseite live ist
let statusTimer = null;
function onStatus(s) {
  const changed = sync.status !== s;
  sync.status = s;
  updateTray();
  if (changed && config.configured) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      sync.report(false).then(r => sync.request("POST", "/api/device/heartbeat", r)).catch(() => {});
    }, 1500);
  }
}

// ---------------------------------------------------------------- Tray
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, "..", "build", IS_MAC ? "trayTemplate.png" : "icon.png"));
  if (IS_MAC) { img.setTemplateImage(true); return img; } // passt sich hellem/dunklem Menüleisten-Design an
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Retail Demo Laptop – ${sync ? sync.status : ""}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${sync ? sync.status : "…"}`, enabled: false },
    { label: sync && sync.state ? `Abgleich: ${sync.state}` : "Abgleich: –", enabled: false },
    { type: "separator" },
    { label: "Demo jetzt starten", enabled: config.configured, click: () => stage.showDemo() },
    { label: "Einstellungen …", click: () => withPin(openSetup) },
    { type: "separator" },
    { label: "Beenden …", click: () => withPin(quit) },
  ]));
}

function quit() {
  stage.quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- IPC
ipcMain.handle("pin:check", (e, pin) => {
  if (!config.checkPin(pin)) return false;
  const w = BrowserWindow.fromWebContents(e.sender);
  const then = w && w.pinThen;
  if (w) { w.pinThen = null; w.close(); }
  if (then) setTimeout(then, 50);
  return true;
});

ipcMain.handle("setup:get", () => ({
  serverUrl: config.data.serverUrl,
  hasToken: !!config.data.deviceToken,
  hasPin: !!config.data.pinHash,
  platform: process.platform,
  autostart: config.data.autostart !== false,
  deviceId: config.data.deviceId,
  version: app.getVersion(),
  state: sync.state,
  lastSync: config.data.lastSync,
  lastError: config.data.lastError,
  local: sync.local,
  manifest: sync.manifest ? { display_name: sync.manifest.display_name, playlist_name: sync.manifest.playlist_name, items: sync.manifest.items.length, idle_timeout_s: sync.manifest.idle_timeout_s } : null,
  filter: {
    supported: filter.SUPPORTED,
    installed: filter.installed(),
    wanted: (sync.manifest && sync.manifest.web_filter) || "off",
    domains: (sync.manifest && sync.manifest.blocked_domains || []).length,
    state: filter.describe(sync.manifest),
  },
}));

ipcMain.handle("setup:save", async (_e, form) => {
  const serverUrl = normalizeUrl(form.serverUrl);
  const deviceToken = (form.deviceToken || "").trim() || config.data.deviceToken;
  if (!serverUrl) return { error: "Bitte die Server-Adresse eintragen" };
  if (!deviceToken) return { error: "Bitte das Geräte-Token (DEVICE_TOKEN) eintragen" };
  if (!config.data.pinHash && !form.pin) return { error: "Bitte eine PIN festlegen" };
  if (form.pin && !/^\d{4,8}$/.test(form.pin)) return { error: "Die PIN muss aus 4 bis 8 Ziffern bestehen" };
  try { await sync.test(serverUrl, deviceToken); }
  catch (e) { return { error: `Verbindung fehlgeschlagen: ${e.message}` }; }
  config.set({ serverUrl, deviceToken, autostart: !!form.autostart });
  if (form.pin) config.setPin(form.pin);
  applyAutostart();
  const err = await sync.syncNow();
  updateTray();
  return { ok: true, syncError: err };
});

ipcMain.handle("setup:sync", () => sync.syncNow());
ipcMain.on("setup:startDemo", () => { if (setupWin) setupWin.close(); setTimeout(() => stage.showDemo(), 300); });
ipcMain.on("setup:quit", () => quit());

async function filterAction(fn) {
  try {
    await fn();
    filter.apply(sync.manifest);
    // Webseite / Admin-App gleich informieren
    sync.report(false).then(r => sync.request("POST", "/api/device/heartbeat", r)).catch(() => {});
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}
ipcMain.handle("filter:install", () => filterAction(filter.install));
ipcMain.handle("filter:uninstall", () => filterAction(filter.uninstall));

// ---------------------------------------------------------------- Start
function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: config.data.autostart !== false });
}

app.on("second-instance", () => withPin(openSetup));
app.on("window-all-closed", () => { /* läuft im Hintergrund weiter */ });
app.on("before-quit", e => { if (!stage || !stage.quitting) e.preventDefault(); });

app.whenReady().then(async () => {
  config = new Config(app.getPath("userData"));
  sync = new Sync(config, app.getPath("userData"), app.getVersion());
  stage = new Stage({
    viewModel,
    idleTimeout: () => (sync.manifest && sync.manifest.idle_timeout_s) || DEFAULT_IDLE_S,
    isActive: () => isActiveAt(sync.manifest && sync.manifest.schedule),
    isBusy: () => !config.configured || !!setupWin || !!pinWin,
    onStatus,
  });
  sync.on("updated", () => { stage.pushViewModel(); updateTray(); filter.apply(sync.manifest); });
  sync.on("state", () => { updateTray(); if (setupWin) setupWin.webContents.send("state", sync.state); });

  tray = new Tray(trayIcon());
  if (!IS_MAC) tray.on("click", () => tray.popUpContextMenu()); // Mac öffnet das Menü von selbst
  updateTray();

  stage.start();
  globalShortcut.register("Control+Alt+Shift+D", () => withPin(openSetup));

  await sync.init();
  if (!config.configured) openSetup();
  applyAutostart();
  sync.start();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
