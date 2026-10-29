// Retail Demo Laptop – Hauptprozess
//
// Ablauf wie bei Intel iPOS / AMD Advance:
// - Niemand benutzt den Laptop (Standard 60 s) -> Vollbild-Präsentation mit Logo, animierten Specs und Videos
// - Kunde bewegt Maus / tippt -> Präsentation verschwindet sofort, Laptop ist normal benutzbar
// - Während der Kunde den Laptop benutzt, hängt rechts am Bildschirmrand eine kleine "Specs"-Lasche,
//   die sich zu einem Datenblatt aufklappen lässt
// Einstellungen: Tray-Symbol (Windows: unten rechts, Mac: Menüleiste) oder Strg+Alt+Umschalt+D
// (Mac: ⌃⌥⇧D), jeweils mit PIN.
const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, powerSaveBlocker, screen, globalShortcut, nativeImage } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const { Config, normalizeUrl } = require("./config");
const { Sync } = require("./sync");
const { isActiveAt } = require("./schedule");
const filter = require("./filter");

if (!app.requestSingleInstanceLock()) app.quit();

app.setAppUserModelId("de.retaildemo.laptop");
// Videos sollen ohne vorherigen Klick starten
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const IS_MAC = process.platform === "darwin";
const DEFAULT_IDLE_S = 60;
const PANEL_TAB = { width: 52, height: 168 };
const PANEL_OPEN = { width: 420, height: 700 };

let config, sync, tray;
let demoWin = null, panelWin = null, setupWin = null, pinWin = null;
let demoVisible = false, demoShownAt = 0, lastIdle = 0;
let panelOpen = false;
let powerBlockId = null;
let quitting = false;

const asset = f => path.join(__dirname, f);
const fileUrl = (p, v) => pathToFileURL(p).href + (v ? `?v=${v}` : "");

// ---------------------------------------------------------------- Daten für die Oberflächen
function viewModel() {
  const m = sync.manifest || {};
  const local = sync.local || { specs: [] };
  const items = (m.items || []).filter(it => sync.isAvailable(it)).map(it => ({
    id: it.id, type: it.type, duration_s: it.duration_s, src: fileUrl(sync.localFile(it)),
  }));
  const logo = sync.logoFile(m);
  return {
    items,
    display_name: m.display_name || local.marketing_name || "",
    manufacturer: m.manufacturer || local.manufacturer || "",
    specs: m.specs && m.specs.length ? m.specs : local.specs,
    show_specs: m.show_specs !== false,
    specs_every_n: m.specs_every_n || 3,
    specs_duration_s: Math.max(8, m.specs_duration_s || 12),
    store_name: m.store_name || "",
    logo: logo && require("fs").existsSync(logo) ? fileUrl(logo, m.logo_sha256.slice(0, 8)) : "",
  };
}

function pushViewModel() {
  const vm = viewModel();
  for (const w of [demoWin, panelWin]) if (w && !w.isDestroyed()) w.webContents.send("vm", vm);
}

// ---------------------------------------------------------------- Fenster
const webPrefs = { preload: asset("preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };

function createDemoWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  demoWin = new BrowserWindow({
    ...bounds, show: false, frame: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#0b0e14", webPreferences: webPrefs,
    // Mac: kein echtes Vollbild (eigener Desktop mit Animation), sondern "einfaches" Vollbild beim Einblenden
    ...(IS_MAC ? { fullscreenable: false, enableLargerThanScreen: true, acceptFirstMouse: true } : { fullscreen: true, kiosk: true }),
  });
  demoWin.setAlwaysOnTop(true, "screen-saver");
  // Mac: auch über Apps im Vollbild und auf allen Schreibtischen (Spaces) sichtbar
  if (IS_MAC) demoWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  demoWin.setMenu(null);
  demoWin.loadFile(asset("demo.html"));
  demoWin.on("close", e => { if (!quitting) e.preventDefault(); });
  // Klick auf einen anderen Bildschirm o. Ä.: Demo zurückziehen, damit nichts "hängen" bleibt
  demoWin.on("blur", () => { if (demoVisible && Date.now() - demoShownAt > 1500) hideDemo(); });
}

function panelBounds(open) {
  const area = screen.getPrimaryDisplay().workArea;
  const size = open ? { width: PANEL_OPEN.width, height: Math.min(PANEL_OPEN.height, area.height - 40) } : PANEL_TAB;
  return { ...size, x: area.x + area.width - size.width, y: Math.round(area.y + (area.height - size.height) / 2) };
}

function createPanelWindow() {
  panelWin = new BrowserWindow({
    ...panelBounds(false), show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    hasShadow: false, acceptFirstMouse: true, webPreferences: webPrefs,
  });
  panelWin.setAlwaysOnTop(true, "floating");
  if (IS_MAC) panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWin.setMenu(null);
  panelWin.loadFile(asset("panel.html"));
  panelWin.on("close", e => { if (!quitting) e.preventDefault(); });
  panelWin.on("blur", () => setPanelOpen(false));
}

function setPanelOpen(open) {
  if (!panelWin || panelOpen === open) return;
  panelOpen = open;
  panelWin.webContents.send("panel:open", open);
  // Beim Zuklappen erst die Animation abwarten, dann das Fenster verkleinern
  if (open) panelWin.setBounds(panelBounds(true));
  else setTimeout(() => { if (!panelOpen && panelWin) panelWin.setBounds(panelBounds(false)); }, 260);
}

function openWindow(file, opts) {
  const w = new BrowserWindow({ show: false, autoHideMenuBar: true, backgroundColor: "#f5f6f8", webPreferences: webPrefs, ...opts });
  w.setMenu(null);
  w.loadFile(asset(file));
  w.once("ready-to-show", () => { if (IS_MAC) app.focus({ steal: true }); w.show(); w.focus(); });
  return w;
}

function openSetup() {
  if (setupWin) return setupWin.focus();
  hideDemo();
  setupWin = openWindow("setup.html", { width: 620, height: 820, minWidth: 520, title: "Retail Demo Laptop – Einstellungen", alwaysOnTop: true });
  setupWin.on("closed", () => { setupWin = null; lastIdle = 0; });
}

/** Fragt die PIN ab und ruft danach [then] auf. Ohne festgelegte PIN direkt weiter. */
function withPin(then) {
  if (!config.data.pinHash) return then();
  if (pinWin) return pinWin.focus();
  hideDemo();
  pinWin = openWindow("pin.html", { width: 380, height: 300, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true, title: "PIN" });
  pinWin.setAlwaysOnTop(true, "screen-saver");
  pinWin.pinThen = then;
  pinWin.on("closed", () => { pinWin = null; });
}

// ---------------------------------------------------------------- Demo ein/aus
function showDemo() {
  if (!demoWin || demoVisible) return;
  demoVisible = true;
  demoShownAt = Date.now();
  setPanelOpen(false);
  if (panelWin) panelWin.hide();
  demoWin.setBounds(screen.getPrimaryDisplay().bounds);
  if (IS_MAC) {
    // Menüleiste und Dock ausblenden, Tastatur-Fokus holen (die App läuft sonst im Hintergrund)
    demoWin.show();
    demoWin.setSimpleFullScreen(true);
    app.focus({ steal: true });
  } else {
    demoWin.show();
    demoWin.setKiosk(true);
  }
  demoWin.setAlwaysOnTop(true, "screen-saver");
  demoWin.focus();
  demoWin.webContents.send("demo:start", viewModel());
  setStatus("Demo läuft");
}

function hideDemo() {
  if (!demoWin || !demoVisible) return;
  demoVisible = false;
  demoWin.webContents.send("demo:stop");
  if (IS_MAC) demoWin.setSimpleFullScreen(false);
  demoWin.hide();
  lastIdle = 0;
  setStatus("Kunde benutzt Gerät");
}

function setStatus(s) {
  if (sync) sync.status = s;
  updateTray();
}

// ---------------------------------------------------------------- Hauptschleife (1×/Sekunde)
function tick() {
  const busy = !config.configured || setupWin || pinWin;
  const active = isActiveAt(sync.manifest && sync.manifest.schedule);
  setPowerBlock(active && !busy);
  if (busy) {
    hideDemo();
    if (panelWin && panelWin.isVisible()) panelWin.hide();
    return;
  }
  const idle = powerMonitor.getSystemIdleTime();
  const timeout = (sync.manifest && sync.manifest.idle_timeout_s) || DEFAULT_IDLE_S;
  if (demoVisible) {
    if (!active) { hideDemo(); setStatus("Ruhezeit"); }
    // Leerlaufzeit springt zurück = jemand hat Maus/Tastatur/Touchpad benutzt
    else if (Date.now() - demoShownAt > 1500 && idle < lastIdle) hideDemo();
  } else if (active && idle >= timeout) {
    showDemo();
  } else if (!active && sync.status !== "Ruhezeit") {
    setStatus("Ruhezeit");
  } else if (active && sync.status === "Ruhezeit") {
    setStatus("Kunde benutzt Gerät");
  }
  lastIdle = idle;

  const wantPanel = active && !demoVisible && viewModel().show_specs;
  if (panelWin) {
    if (wantPanel && !panelWin.isVisible()) { panelWin.setBounds(panelBounds(panelOpen)); panelWin.showInactive(); }
    else if (!wantPanel && panelWin.isVisible()) { setPanelOpen(false); panelWin.hide(); }
    // Andere Fenster im Vollbild dürfen die Lasche nicht verdecken
    if (wantPanel) panelWin.setAlwaysOnTop(true, "floating");
  }
}

/** Während der Öffnungszeiten darf der Bildschirm nicht ausgehen. */
let appNapBlock = null;
function setPowerBlock(on) {
  // Mac: "App Nap" würde die Leerlauf-Prüfung im Hintergrund ausbremsen
  if (IS_MAC && appNapBlock === null) appNapBlock = powerSaveBlocker.start("prevent-app-suspension");
  if (on && powerBlockId === null) powerBlockId = powerSaveBlocker.start("prevent-display-sleep");
  else if (!on && powerBlockId !== null) { powerSaveBlocker.stop(powerBlockId); powerBlockId = null; }
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
    { label: "Demo jetzt starten", enabled: config.configured, click: () => showDemo() },
    { label: "Einstellungen …", click: () => withPin(openSetup) },
    { type: "separator" },
    { label: "Beenden …", click: () => withPin(quit) },
  ]));
}

function quit() {
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- IPC
ipcMain.on("demo:input", () => { if (demoVisible && Date.now() - demoShownAt > 800) hideDemo(); });
ipcMain.on("demo:startNow", () => showDemo());
ipcMain.on("panel:toggle", (_e, open) => {
  setPanelOpen(open);
  if (open) panelWin.focus();
});
ipcMain.handle("vm", () => viewModel());

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
ipcMain.on("setup:startDemo", () => { if (setupWin) setupWin.close(); setTimeout(showDemo, 300); });
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
app.on("before-quit", e => { if (!quitting) e.preventDefault(); });

app.whenReady().then(async () => {
  config = new Config(app.getPath("userData"));
  sync = new Sync(config, app.getPath("userData"), app.getVersion());
  sync.on("updated", () => { pushViewModel(); updateTray(); filter.apply(sync.manifest); });
  sync.on("state", () => { updateTray(); if (setupWin) setupWin.webContents.send("state", sync.state); });

  tray = new Tray(trayIcon());
  if (!IS_MAC) tray.on("click", () => tray.popUpContextMenu()); // Mac öffnet das Menü von selbst
  updateTray();

  createDemoWindow();
  createPanelWindow();
  globalShortcut.register("Control+Alt+Shift+D", () => withPin(openSetup));
  screen.on("display-metrics-changed", () => { if (panelWin) panelWin.setBounds(panelBounds(panelOpen)); });

  await sync.init();
  if (!config.configured) openSetup();
  applyAutostart();
  sync.start();
  setInterval(tick, 1000);
});

app.on("will-quit", () => globalShortcut.unregisterAll());
