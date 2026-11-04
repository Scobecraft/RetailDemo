// Die "Bühne": Vollbild-Präsentation und Specs-Lasche samt Leerlauf-Erkennung.
// Gemeinsam genutzt von der Online-Version (main.js) und der Offline-Version (offline/main.js).
const { app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, screen } = require("electron");
const path = require("path");

const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux"; // Fenster-Transparenz gibt es dort nicht überall
const PANEL_TAB = { width: 52, height: 168 };
const PANEL_OPEN = { width: 420, height: 700 };

const asset = f => path.join(__dirname, f);
const webPrefs = { preload: asset("preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true };

class Stage {
  /**
   * @param {object} hooks
   *   viewModel()   -> Daten für Präsentation und Lasche
   *   idleTimeout() -> Sekunden ohne Bedienung bis zur Präsentation
   *   isActive()    -> innerhalb der Betriebszeiten?
   *   isBusy()      -> Mitarbeiter-Fenster offen / Update läuft -> keine Demo, keine Lasche
   *   onStatus(s)   -> "Demo läuft", "Kunde benutzt Gerät", "Ruhezeit"
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.demoWin = null;
    this.panelWin = null;
    this.demoVisible = false;
    this.demoShownAt = 0;
    this.lastIdle = 0;
    this.panelOpen = false;
    this.quitting = false;
    this.status = "";
    this.powerBlockId = null;
    this.appNapBlock = null;

    ipcMain.on("demo:input", () => { if (this.demoVisible && Date.now() - this.demoShownAt > 800) this.hideDemo(); });
    ipcMain.on("demo:startNow", () => this.showDemo());
    ipcMain.on("panel:toggle", (_e, open) => {
      this.setPanelOpen(open);
      if (open) this.panelWin.focus();
    });
    ipcMain.handle("vm", () => this.hooks.viewModel());
  }

  start() {
    this.createDemoWindow();
    this.createPanelWindow();
    screen.on("display-metrics-changed", () => { if (this.panelWin) this.panelWin.setBounds(this.panelBounds(this.panelOpen)); });
    setInterval(() => this.tick(), 1000);
  }

  // ---------------------------------------------------------------- Fenster
  createDemoWindow() {
    const { bounds } = screen.getPrimaryDisplay();
    const w = this.demoWin = new BrowserWindow({
      ...bounds, show: false, frame: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#0b0e14", webPreferences: webPrefs,
      // Mac: kein echtes Vollbild (eigener Desktop mit Animation), sondern "einfaches" Vollbild beim Einblenden
      ...(IS_MAC ? { fullscreenable: false, enableLargerThanScreen: true, acceptFirstMouse: true } : { fullscreen: true, kiosk: true }),
    });
    w.setAlwaysOnTop(true, "screen-saver");
    // Mac: auch über Apps im Vollbild und auf allen Schreibtischen (Spaces) sichtbar
    if (IS_MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setMenu(null);
    w.loadFile(asset("demo.html"));
    w.on("close", e => { if (!this.quitting) e.preventDefault(); });
    // Klick auf einen anderen Bildschirm o. Ä.: Demo zurückziehen, damit nichts "hängen" bleibt
    w.on("blur", () => { if (this.demoVisible && Date.now() - this.demoShownAt > 1500) this.hideDemo(); });
  }

  panelBounds(open) {
    const area = screen.getPrimaryDisplay().workArea;
    const size = open ? { width: PANEL_OPEN.width, height: Math.min(PANEL_OPEN.height, area.height - 40) } : PANEL_TAB;
    return { ...size, x: area.x + area.width - size.width, y: Math.round(area.y + (area.height - size.height) / 2) };
  }

  createPanelWindow() {
    const w = this.panelWin = new BrowserWindow({
      ...this.panelBounds(false), show: false, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, acceptFirstMouse: true, webPreferences: webPrefs,
    });
    w.setAlwaysOnTop(true, "floating");
    if (IS_MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setMenu(null);
    w.loadFile(asset("panel.html"));
    w.on("close", e => { if (!this.quitting) e.preventDefault(); });
    w.on("blur", () => this.setPanelOpen(false));
  }

  setPanelOpen(open) {
    if (!this.panelWin || this.panelOpen === open) return;
    this.panelOpen = open;
    this.panelWin.webContents.send("panel:open", open);
    // Beim Zuklappen erst die Animation abwarten, dann das Fenster verkleinern
    if (open) this.panelWin.setBounds(this.panelBounds(true));
    else setTimeout(() => { if (!this.panelOpen && this.panelWin) this.panelWin.setBounds(this.panelBounds(false)); }, 260);
  }

  pushViewModel() {
    const vm = this.hooks.viewModel();
    for (const w of [this.demoWin, this.panelWin]) if (w && !w.isDestroyed()) w.webContents.send("vm", vm);
  }

  /** Läuft die Präsentation gerade, mit neuen Inhalten von vorn beginnen. */
  restartDemo() {
    if (this.demoVisible) this.demoWin.webContents.send("demo:start", this.hooks.viewModel());
    this.pushViewModel();
  }

  // ---------------------------------------------------------------- Demo ein/aus
  showDemo() {
    if (!this.demoWin || this.demoVisible) return;
    const w = this.demoWin;
    this.demoVisible = true;
    this.demoShownAt = Date.now();
    this.setPanelOpen(false);
    if (this.panelWin) this.panelWin.hide();
    w.setBounds(screen.getPrimaryDisplay().bounds);
    // Erst neu zeichnen lassen, dann einblenden – sonst blitzt kurz das letzte Bild der vorigen Runde auf
    w.webContents.send("demo:start", this.hooks.viewModel());
    if (!IS_LINUX) { w.setOpacity(0); setTimeout(() => { if (this.demoVisible) w.setOpacity(1); }, 250); }
    if (IS_MAC) {
      // Menüleiste und Dock ausblenden, Tastatur-Fokus holen (die App läuft sonst im Hintergrund)
      w.show();
      w.setSimpleFullScreen(true);
      app.focus({ steal: true });
    } else {
      w.show();
      w.setKiosk(true);
    }
    w.setAlwaysOnTop(true, "screen-saver");
    w.focus();
    this.setStatus("Demo läuft");
  }

  hideDemo() {
    if (!this.demoWin || !this.demoVisible) return;
    this.demoVisible = false;
    this.demoWin.webContents.send("demo:stop");
    if (IS_MAC) this.demoWin.setSimpleFullScreen(false);
    this.demoWin.hide();
    this.lastIdle = 0;
    this.setStatus("Kunde benutzt Gerät");
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.hooks.onStatus(s);
  }

  // ---------------------------------------------------------------- Hauptschleife (1×/Sekunde)
  tick() {
    const busy = this.hooks.isBusy();
    const active = this.hooks.isActive();
    this.setPowerBlock(active && !busy);
    if (busy) {
      this.hideDemo();
      if (this.panelWin && this.panelWin.isVisible()) this.panelWin.hide();
      return;
    }
    const idle = powerMonitor.getSystemIdleTime();
    if (this.demoVisible) {
      if (!active) { this.hideDemo(); this.setStatus("Ruhezeit"); }
      // Leerlaufzeit springt zurück = jemand hat Maus/Tastatur/Touchpad benutzt
      else if (Date.now() - this.demoShownAt > 1500 && idle < this.lastIdle) this.hideDemo();
    } else if (active && idle >= this.hooks.idleTimeout()) {
      this.showDemo();
    } else if (!active) {
      this.setStatus("Ruhezeit");
    } else if (this.status === "Ruhezeit") {
      this.setStatus("Kunde benutzt Gerät");
    }
    this.lastIdle = idle;

    const wantPanel = active && !this.demoVisible && this.hooks.viewModel().show_specs;
    const p = this.panelWin;
    if (p) {
      if (wantPanel && !p.isVisible()) { p.setBounds(this.panelBounds(this.panelOpen)); p.showInactive(); }
      else if (!wantPanel && p.isVisible()) { this.setPanelOpen(false); p.hide(); }
      // Andere Fenster im Vollbild dürfen die Lasche nicht verdecken
      if (wantPanel) p.setAlwaysOnTop(true, "floating");
    }
  }

  /** Während der Betriebszeiten darf der Bildschirm nicht ausgehen. */
  setPowerBlock(on) {
    // Mac: "App Nap" würde die Leerlauf-Prüfung im Hintergrund ausbremsen
    if (IS_MAC && this.appNapBlock === null) this.appNapBlock = powerSaveBlocker.start("prevent-app-suspension");
    if (on && this.powerBlockId === null) this.powerBlockId = powerSaveBlocker.start("prevent-display-sleep");
    else if (!on && this.powerBlockId !== null) { powerSaveBlocker.stop(this.powerBlockId); this.powerBlockId = null; }
  }
}

/** Kleines Zusatzfenster (Einstellungen, PIN, Info). */
function openWindow(file, opts) {
  const w = new BrowserWindow({ show: false, autoHideMenuBar: true, backgroundColor: "#f5f6f8", webPreferences: webPrefs, ...opts });
  w.setMenu(null);
  w.loadFile(asset(file));
  w.once("ready-to-show", () => { if (IS_MAC) app.focus({ steal: true }); w.show(); w.focus(); });
  return w;
}

module.exports = { Stage, openWindow, asset, webPrefs, IS_MAC };
