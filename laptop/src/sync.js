// Abgleich mit dem Retail-Demo-Server – gleiches Verfahren wie die Handy-Demo:
// - alle sync_interval_min Minuten (Standard 1×/Stunde) ein vollständiger Abgleich (Manifest + Dateien)
// - alle paar Minuten ein Heartbeat (Online-Status, "Jetzt aktualisieren" aus Webseite/Admin-App)
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { net } = require("electron");
const specs = require("./specs");
const filter = require("./filter");

const EXT = {
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv", "video/x-m4v": ".m4v",
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg",
};

class Sync extends EventEmitter {
  constructor(config, dataDir, appVersion) {
    super();
    this.config = config;
    this.appVersion = appVersion;
    this.mediaDir = path.join(dataDir, "media");
    this.manifestFile = path.join(dataDir, "manifest.json");
    fs.mkdirSync(this.mediaDir, { recursive: true });
    try { this.manifest = JSON.parse(fs.readFileSync(this.manifestFile, "utf8")); } catch { this.manifest = null; }
    this.state = "";
    this.status = "Gestartet";
    this.local = null;          // automatisch erkannte Hardware
    this.running = null;        // laufender Abgleich (Promise)
    this.nextRetryAt = 0;
  }

  async init() {
    this.local = await specs.collect();
    if (!this.config.data.deviceId) this.config.set({ deviceId: await specs.deviceId() });
    this.emit("updated");
  }

  start() {
    const loop = async () => {
      if (this.isDue()) await this.syncNow();
      this.syncTimer = setTimeout(loop, 30_000);
    };
    const beat = async () => {
      let wait = 300;
      if (this.config.configured) {
        try {
          const r = await this.request("POST", "/api/device/heartbeat", await this.report(false));
          wait = r.heartbeat_interval_s || 300;
          if (r.sync_now) await this.syncNow();
        } catch (e) { console.warn("Heartbeat fehlgeschlagen:", e.message); }
      }
      this.beatTimer = setTimeout(beat, wait * 1000);
    };
    loop();
    this.beatTimer = setTimeout(beat, 5000);
  }

  isDue() {
    const interval = ((this.manifest && this.manifest.sync_interval_min) || 60) * 60_000;
    const now = Date.now();
    return this.config.configured && now >= (this.config.data.lastSync || 0) + interval && now >= this.nextRetryAt;
  }

  // ------------------------------------------------------------------ Server
  async request(method, urlPath, body, cfg = this.config.data) {
    const res = await net.fetch(cfg.serverUrl + urlPath, {
      method,
      headers: { Authorization: `Bearer ${cfg.deviceToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const msg = res.status === 401 ? "Geräte-Token ungültig" : (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Server-Fehler ${res.status}: ${msg}`);
    }
    return res.json();
  }

  /** Prüft Adresse und Token, ohne etwas zu speichern. */
  async test(serverUrl, deviceToken) {
    const res = await net.fetch(serverUrl + "/api/health");
    if (!res.ok) throw new Error(`Server antwortet nicht richtig (${res.status})`);
    // Heartbeat prüft das Geräte-Token
    await this.request("POST", "/api/device/heartbeat", await this.report(false), { serverUrl, deviceToken });
  }

  async report(withSpecs) {
    const l = this.local || {};
    return {
      device_id: this.config.data.deviceId,
      platform: specs.platformName(),
      manufacturer: l.manufacturer || "",
      model: l.model || "",
      marketing_name: l.marketing_name || "",
      os_version: l.os_version || "",
      app_version: this.appVersion,
      specs: withSpecs ? l.specs || [] : [],
      synced_hash: this.config.data.syncedHash || null,
      status: [this.status, filter.describe(this.manifest)].filter(Boolean).join(" · "),
      error: this.config.data.lastError || null,
      battery: await specs.batteryPercent(),
    };
  }

  // ------------------------------------------------------------------ Dateien
  localFile(item) { return path.join(this.mediaDir, item.id + (EXT[item.mime] || "")); }

  isAvailable(item) {
    try { return fs.statSync(this.localFile(item)).size === item.size; } catch { return false; }
  }

  logoFile(m = this.manifest) {
    return m && m.logo_sha256 ? path.join(this.mediaDir, "logo-" + m.logo_sha256.slice(0, 16) + (EXT[m.logo_mime] || ".png")) : null;
  }

  async download(urlPath, dest, sha256) {
    const part = dest + ".part";
    const res = await net.fetch(this.config.data.serverUrl + urlPath, { headers: { Authorization: `Bearer ${this.config.data.deviceToken}` } });
    if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
    const hash = crypto.createHash("sha256");
    const body = Readable.fromWeb(res.body);
    body.on("data", chunk => hash.update(chunk));
    await pipeline(body, fs.createWriteStream(part));
    if (sha256 && hash.digest("hex") !== sha256) {
      fs.rmSync(part, { force: true });
      throw new Error("Prüfsumme falsch");
    }
    fs.renameSync(part, dest);
  }

  /** Vollständiger Abgleich. Gibt null bei Erfolg zurück, sonst die Fehlermeldung. */
  syncNow() {
    if (!this.running) this.running = this._sync().finally(() => { this.running = null; });
    return this.running;
  }

  async _sync() {
    if (!this.config.configured) return "Server nicht eingerichtet";
    this.setState("Verbinde mit Server …");
    let error = null;
    try {
      const m = await this.request("POST", "/api/device/sync", await this.report(true));
      let failed = 0;
      for (const [i, item] of m.items.entries()) {
        if (this.isAvailable(item)) continue;
        this.setState(`Lade Datei ${i + 1} von ${m.items.length} …`);
        try { await this.download(item.url, this.localFile(item), item.sha256); }
        catch (e) { console.warn(`Download ${item.id}:`, e.message); failed++; }
      }
      const logo = this.logoFile(m);
      if (logo && !fs.existsSync(logo)) {
        try { await this.download(m.logo_url, logo, m.logo_sha256); }
        catch (e) { console.warn("Logo:", e.message); failed++; }
      }
      // Nicht mehr benötigte Dateien (und abgebrochene Downloads) löschen
      const keep = new Set(m.items.map(it => path.basename(this.localFile(it))));
      if (logo) keep.add(path.basename(logo));
      for (const f of fs.readdirSync(this.mediaDir)) if (!keep.has(f)) fs.rmSync(path.join(this.mediaDir, f), { force: true });

      this.manifest = m;
      fs.writeFileSync(this.manifestFile, JSON.stringify(m));
      if (failed === 0) this.config.set({ syncedHash: m.hash, lastSync: Date.now() });
      else error = `${failed} Datei(en) konnten nicht geladen werden`;
    } catch (e) {
      console.warn("Abgleich fehlgeschlagen:", e);
      error = e.message || String(e);
    }
    this.config.set({ lastError: error });
    // Bei Fehlern in 5 Minuten erneut versuchen statt erst in einer Stunde
    this.nextRetryAt = error ? Date.now() + 5 * 60_000 : 0;
    this.setState(error ? `Fehler: ${error}` : "Aktuell");
    this.emit("updated");
    // Webseite/Admin-App sofort über den neuen Stand informieren
    if (!error) this.report(false).then(r => this.request("POST", "/api/device/heartbeat", r)).catch(() => {});
    return error;
  }

  setState(s) { this.state = s; this.emit("state", s); }
}

module.exports = { Sync };
