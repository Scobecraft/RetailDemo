// Liest die Hardware des Laptops aus und macht daraus verkaufsfertige Specs auf Deutsch.
const si = require("systeminformation");
const crypto = require("crypto");
const { execFile } = require("child_process");

const run = (cmd, args) => new Promise(resolve =>
  execFile(cmd, args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? "" : String(out))));

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

// ---------------------------------------------------------------- Mac
// system_profiler/ioreg kennen Verkaufsname ("MacBook Air (13-inch, M3, 2024)"), Chip und GPU-Kerne.
async function collectMac() {
  const [hwJson, ioreg, disks, bat, os] = await Promise.all([
    run("/usr/sbin/system_profiler", ["-json", "SPHardwareDataType", "SPDisplaysDataType"]),
    run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]),
    settle(si.diskLayout()), settle(si.battery()), settle(si.osInfo()),
  ]);
  let hw = {}, gpu = {}, display = null;
  try {
    const j = JSON.parse(hwJson);
    hw = (j.SPHardwareDataType || [])[0] || {};
    gpu = (j.SPDisplaysDataType || [])[0] || {};
    const screens = gpu.spdisplays_ndrvs || [];
    display = screens.find(d => /internal|built-in/i.test(`${d.spdisplays_connection_type} ${d.spdisplays_display_type}`)) || screens[0] || null;
  } catch {}
  // Apple Silicon: Verkaufsname steht in ioreg als product-name
  const m = /"product-name"\s*=\s*<"([^"]+)">/.exec(ioreg);
  const marketing = (m && m[1]) || hw.machine_name || "Mac";

  const specs = [];
  const chip = hw.chip_type || hw.cpu_type || "";
  if (chip) {
    // "proc 12:6:6" = gesamt : Performance : Effizienz
    const p = /proc (\d+):(\d+):(\d+)/.exec(hw.number_processors || "");
    const cores = p ? ` (${p[1]} Kerne: ${p[2]} Performance + ${p[3]} Effizienz)` : hw.number_processors ? ` (${hw.number_processors} Kerne)` : "";
    specs.push({ label: "Chip", value: chip + cores });
  }
  if (gpu.sppci_cores) specs.push({ label: "Grafik", value: `${gpu.sppci_cores}-Kern-GPU` });
  else if (gpu.sppci_model && gpu.sppci_model !== chip) specs.push({ label: "Grafik", value: gpu.sppci_model });
  if (hw.physical_memory) specs.push({ label: "Arbeitsspeicher", value: hw.physical_memory.replace(/\s+/, " ") });
  const storage = storageSpec(disks);
  if (storage) specs.push(storage);
  if (display) {
    const type = String(display.spdisplays_display_type || "").toLowerCase();
    const name = /xdr/.test(type) ? "Liquid Retina XDR" : /liquid/.test(type) ? "Liquid Retina" : /retina/.test(type) ? "Retina" : "";
    const size = /\((\d+(?:[.,]\d)?)-inch/i.exec(marketing);
    const px = /(\d+)\s*x\s*(\d+)/.exec(display._spdisplays_pixels || display.spdisplays_resolution || "");
    const hz = /@\s*([\d.]+)\s*Hz/i.exec(display._spdisplays_resolution || "");
    const parts = [size ? `${size[1].replace(".", ",")}"` : "", name, px ? `${px[1]} × ${px[2]}` : "", hz && +hz[1] > 61 ? `${Math.round(+hz[1])} Hz` : ""].filter(Boolean);
    if (parts.length) specs.push({ label: "Display", value: parts.join(" · ") });
  }
  const battery = batterySpec(bat);
  if (battery) specs.push(battery);
  const osName = os ? `macOS ${os.codename ? os.codename.replace(/^macOS\s*/i, "") + " " : ""}${os.release || ""}`.trim() : "";
  if (osName) specs.push({ label: "Betriebssystem", value: osName });

  return { manufacturer: "Apple", model: hw.machine_model || hw.model_number || "", marketing_name: marketing, os_version: osName, specs };
}

function storageSpec(disks) {
  if (!disks || !disks.length) return null;
  const internal = disks.filter(d => d.size > 32e9 && !/usb/i.test(d.interfaceType || ""));
  const total = internal.reduce((a, d) => a + d.size, 0);
  if (!total) return null;
  const tb = total / 1e12;
  const size = tb >= 0.9 ? `${de(Math.round(tb * 2) / 2)} TB` : `${[128, 256, 512].find(s => total / 1e9 <= s * 1.05) || Math.round(total / 1e9)} GB`;
  const ssd = internal.some(d => /ssd|nvme|apple/i.test(`${d.type} ${d.interfaceType} ${d.name}`));
  return { label: "Speicher", value: `${size} ${ssd ? "SSD" : ""}`.trim() };
}

function batterySpec(bat) {
  if (!bat || !bat.hasBattery) return null;
  const wh = bat.capacityUnit === "mWh" && bat.designedCapacity ? Math.round(bat.designedCapacity / 1000) : 0;
  return wh > 10 ? { label: "Akku", value: `${wh} Wh` } : null;
}

// ---------------------------------------------------------------- Windows / Linux
async function collect() {
  if (process.platform === "darwin") return collectMac();
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
  const storage = storageSpec(disks);
  if (storage) specs.push(storage);
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
  const battery = batterySpec(bat);
  if (battery) specs.push(battery);
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
