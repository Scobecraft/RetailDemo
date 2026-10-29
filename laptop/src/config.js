// Einstellungen des Laptops (Server, Token, PIN) – liegen in %APPDATA%/Retail Demo Laptop/config.json
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class Config {
  constructor(dir) {
    this.file = path.join(dir, "config.json");
    this.data = { serverUrl: "", deviceToken: "", pinHash: "", deviceId: "", autostart: true, syncedHash: "", lastSync: 0, lastError: null };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, "utf8"))); } catch {}
  }

  get configured() { return !!(this.data.serverUrl && this.data.deviceToken && this.data.pinHash); }

  set(values) {
    Object.assign(this.data, values);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  setPin(pin) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.pbkdf2Sync(String(pin), salt, 200000, 32, "sha256");
    this.set({ pinHash: `${salt.toString("hex")}$${hash.toString("hex")}` });
  }

  checkPin(pin) {
    const [salt, hash] = (this.data.pinHash || "").split("$");
    if (!salt || !hash) return true; // noch keine PIN festgelegt
    const test = crypto.pbkdf2Sync(String(pin), Buffer.from(salt, "hex"), 200000, 32, "sha256");
    return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
  }
}

function normalizeUrl(input) {
  let u = String(input || "").trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = "http://" + u;
  return u;
}

module.exports = { Config, normalizeUrl };
