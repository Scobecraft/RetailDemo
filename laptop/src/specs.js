// Liest die Hardware des Laptops aus und macht daraus verkaufsfertige Specs auf Deutsch.
const si = require("systeminformation");
const crypto = require("crypto");

const BRANDS = [
  [/lenovo/i, "Lenovo"], [/^hp|hewlett/i, "HP"], [/dell/i, "Dell"], [/asus/i, "ASUS"], [/acer/i, "Acer"],
  [/micro-star|^msi/i, "MSI"], [/microsoft/i, "Microsoft"], [/apple/i, "Apple"], [/samsung/i, "Samsung"],
  [/huawei/i, "Huawei"], [/medion/i, "Medion"], [/gigabyte/i, "Gigabyte"], [/razer/i, "Razer"],
  [/xiaomi/i, "Xiaomi"], [/fujitsu/i, "Fujitsu"], [/dynabook|toshiba/i, "Dynabook"], [/lg electronics/i, "LG"],
];

const de = (n, digits = 1) => Number(n).toFixed(digits).replace(/\.0+$/, "").replace(".", ",");

function brandName(raw) {
  const s = String(raw || "").trim();
  for (const [re, name] of BRANDS) if (re.test(s)) return name;
  return s.replace(/\s+(inc\.?|corporation|corp\.?|co\.,? ?ltd\.?|gmbh|computer inc\.?)$/i, "");
}

const settle = p => p.then(v => v, () => null);

// Hersteller-Kürzel und Platzhalter in BIOS-Feldern
const junk = v => !v || /^(to be filled|default string|system product name|not applicable|none|0+|x+)$/i.test(String(v).trim());

function platformName() {
  return { win32: "windows", darwin: "macos" }[process.platform] || "linux";
}

async function deviceId() {
  const u = await settle(si.uuid());
  const sys = await settle(si.system());
  const raw = (u && (u.hardware || u.os)) || (sys && (sys.uuid || sys.serial)) || require("os").hostname();
  return "pc-" + crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 24);
}

async function collect() {
  const [sys, cpu, mem, memLayout, disks, gfx, bat, os] = await Promise.all([
    settle(si.system()), settle(si.cpu()), settle(si.mem()), settle(si.memLayout()),
    settle(si.diskLayout()), settle(si.graphics()), settle(si.battery()), settle(si.osInfo()),
  ]);

  const manufacturer = brandName(sys && sys.manufacturer);
  let model = sys && !junk(sys.model) ? sys.model.trim() : "";
  let marketing = model;
  // Lenovo schreibt den Verkaufsnamen ("ThinkPad T14 Gen 3") in "version", das Modell ist nur eine Nummer
  if (sys && /lenovo/i.test(sys.manufacturer) && !junk(sys.version)) marketing = sys.version.trim();
  if (manufacturer && marketing && !marketing.toLowerCase().startsWith(manufacturer.toLowerCase())) marketing = `${manufacturer} ${marketing}`;

  const specs = [];
  if (cpu && cpu.brand) {
    const name = `${cpu.manufacturer || ""} ${cpu.brand}`.replace(/\(R\)|\(TM\)|®|™|CPU|Processor|@.*$|\d+-Core/gi, "")
      .replace(/^(Intel|AMD|Apple)\s+\1/i, "$1").replace(/\s+/g, " ").trim();
    const extras = [];
    if (cpu.physicalCores) extras.push(`${cpu.physicalCores} Kerne`);
    const maxGhz = Math.max(cpu.speedMax || 0, cpu.speed || 0);
    if (maxGhz) extras.push(`bis ${de(maxGhz)} GHz`);
    specs.push({ label: "Prozessor", value: extras.length ? `${name} (${extras.join(", ")})` : name });
  }
  if (mem && mem.total) {
    // Hersteller-Angabe: auf übliche Größen runden (15,7 GB -> 16 GB)
    const gb = mem.total / 1024 ** 3;
    const nice = [4, 6, 8, 12, 16, 18, 24, 32, 36, 48, 64, 96, 128].find(s => gb <= s * 1.02) || Math.round(gb);
    const type = memLayout && memLayout.find(m => m.type && !/unknown/i.test(m.type));
    specs.push({ label: "Arbeitsspeicher", value: `${nice} GB${type ? " " + type.type : ""}` });
  }
  if (disks && disks.length) {
    const internal = disks.filter(d => d.size > 32e9 && !/usb/i.test(d.interfaceType || ""));
    const total = internal.reduce((a, d) => a + d.size, 0);
    if (total) {
      const tb = total / 1e12;
      const size = tb >= 0.9 ? `${de(Math.round(tb * 2) / 2)} TB` : `${[128, 256, 512].find(s => total / 1e9 <= s * 1.05) || Math.round(total / 1e9)} GB`;
      const ssd = internal.some(d => /ssd|nvme/i.test(`${d.type} ${d.interfaceType}`));
      specs.push({ label: "Speicher", value: `${size} ${ssd ? "SSD" : ""}`.trim() });
    }
  }
  if (gfx && gfx.controllers && gfx.controllers.length) {
    const ctrls = gfx.controllers.filter(c => c.model && !/basic display|remote|virtual|llvmpipe/i.test(c.model));
    // Dedizierte Grafik zuerst
    ctrls.sort((a, b) => (b.vram || 0) - (a.vram || 0));
    if (ctrls.length) {
      const c = ctrls[0];
      const vram = c.vram >= 2048 && /nvidia|radeon rx|arc a/i.test(c.model) ? ` (${Math.round(c.vram / 1024)} GB)` : "";
      specs.push({ label: "Grafik", value: c.model.replace(/\(R\)|\(TM\)/g, "").replace(/\s+/g, " ").trim() + vram });
    }
  }
  if (gfx && gfx.displays && gfx.displays.length) {
    const d = gfx.displays.find(x => x.builtin || x.main) || gfx.displays[0];
    const parts = [];
    if (d.sizeX && d.sizeY) {
      // Windows liefert Zentimeter, andere Systeme Millimeter
      const mm = d.sizeX < 100 ? 10 : 1;
      const inch = Math.hypot(d.sizeX * mm, d.sizeY * mm) / 25.4;
      if (inch > 9 && inch < 25) parts.push(`${de(Math.round(inch * 10) / 10)}"`);
    }
    const w = d.resolutionX || d.currentResX, h = d.resolutionY || d.currentResY;
    if (w && h) parts.push(`${w} × ${h}`);
    if (d.currentRefreshRate > 61) parts.push(`${Math.round(d.currentRefreshRate)} Hz`);
    if (parts.length) specs.push({ label: "Display", value: parts.join(" · ") });
  }
  if (bat && bat.hasBattery) {
    const wh = bat.capacityUnit === "mWh" && bat.designedCapacity ? Math.round(bat.designedCapacity / 1000) : 0;
    if (wh > 10) specs.push({ label: "Akku", value: `${wh} Wh` });
  }
  if (os) {
    const name = String(os.distro || os.platform).replace(/^Microsoft\s+/i, "").replace(/\s+/g, " ").trim();
    if (name) specs.push({ label: "Betriebssystem", value: name });
  }

  return {
    manufacturer,
    model: model || (sys && sys.version) || "",
    marketing_name: marketing,
    os_version: os ? String(os.distro || os.platform).replace(/^Microsoft\s+/i, "") : "",
    specs,
  };
}

async function batteryPercent() {
  const b = await settle(si.battery());
  return b && b.hasBattery ? Math.round(b.percent) : null;
}

module.exports = { collect, deviceId, batteryPercent, platformName };
