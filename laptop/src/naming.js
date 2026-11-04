// Verkaufsnamen aus den BIOS-Feldern ableiten.
// Hersteller schreiben den Namen an unterschiedliche Stellen:
//   Lenovo:  SystemVersion   "IdeaPad Slim 5 16IRL8"   (SystemProductName ist nur "82XF")
//   Samsung: SystemFamily    "Galaxy Book5 360"        (SystemProductName ist nur "750QHA")
//   ASUS:    SystemProductName "ASUS Vivobook 15 X1504VA_X1504VA" (doppelter Code)
//   HP/Dell/Acer/MSI/Microsoft: SystemProductName passt meist schon
const { execFile } = require("child_process");

// Platzhalter, die Hersteller in leeren BIOS-Feldern stehen lassen
const JUNK = /^(to be filled.*|default string|system product name|system version|not applicable|none|n\/a|0+|x+|1\.0|invalid|unknown|type1productconfigid|sku|notebook|laptop|chassis.*)$/i;
const junk = v => !v || JUNK.test(String(v).trim());
const clean = v => String(v || "").replace(/\s+/g, " ").trim();

// Samsung-Modellcodes: Ziffern = Serie/Größe, X = klassisch, Q = 360 (umklappbar), 3. Buchstabe = Generation
const SAMSUNG_GEN = { E: "2", F: "3", G: "4", H: "5" };
const SAMSUNG_KNOWN = {
  "960XFH": "Galaxy Book3 Ultra",
  "960XGL": "Galaxy Book4 Ultra",
  "960XHL": "Galaxy Book5 Ultra",
  "750XGL": "Galaxy Book4 Edge",
};

function samsungFromCode(code) {
  const m = /^(?:NP)?(\d{3})([XQ])([A-Z])([A-Z])/i.exec(code || "");
  if (!m) return "";
  const key = `${m[1]}${m[2]}${m[3]}${m[4]}`.toUpperCase();
  if (SAMSUNG_KNOWN[key]) return SAMSUNG_KNOWN[key];
  const gen = SAMSUNG_GEN[m[3].toUpperCase()];
  if (!gen) return "";
  const series = +m[1];
  const pro = series >= 900 ? " Pro" : "";
  const is360 = m[2].toUpperCase() === "Q" ? " 360" : "";
  return `Galaxy Book${gen}${pro}${is360}`;
}

/** Sieht nach reinem Modellcode aus ("750QHA", "82XF", "21AH00ABGE")? */
const looksLikeCode = s => /^[A-Z0-9][A-Z0-9_-]{2,14}$/i.test(s) && /\d/.test(s) && !/\s/.test(s);

/**
 * @param {object} f  manufacturer (bereits normalisiert, z. B. "Samsung"), product, version, family, sku, board
 * @returns {string}  z. B. "Samsung Galaxy Book5 360"
 */
function marketingName(f) {
  const brand = clean(f.manufacturer);
  const product = junk(f.product) ? "" : clean(f.product);
  const version = junk(f.version) ? "" : clean(f.version);
  const family = junk(f.family) ? "" : clean(f.family);
  const sku = junk(f.sku) ? "" : clean(f.sku);
  let name = product;

  if (/lenovo/i.test(brand)) {
    // "ThinkPad T14 Gen 3" / "IdeaPad Slim 5 16IRL8"; manchmal steht "Lenovo" schon davor
    if (version && !looksLikeCode(version)) name = version;
    else if (family && !looksLikeCode(family)) name = family;
  } else if (/samsung/i.test(brand)) {
    if (/galaxy/i.test(family)) name = family;
    else if (/galaxy/i.test(product)) name = product;
    else name = samsungFromCode(product) || samsungFromCode(sku) || samsungFromCode(f.board) || product;
  } else if (/asus/i.test(brand)) {
    // "Vivobook_ASUSLaptop X1504VA_X1504VA" -> "Vivobook X1504VA"
    name = product.replace(/_ASUSLaptop/i, "").replace(/(\S+)_\1$/, "$1").replace(/_/g, " ");
    if (looksLikeCode(name) && family && !looksLikeCode(family)) name = `${family.replace(/_/g, " ")} ${name}`;
  } else if (looksLikeCode(product) && family && !looksLikeCode(family) && family.toLowerCase() !== brand.toLowerCase()) {
    // Allgemein: Produktfeld enthält nur einen Code, Familie den Namen ("Akoya S15450")
    name = `${family} ${product}`;
  }

  name = clean(name || product || family || version);
  // "HP HP Laptop" / "Samsung Samsung Galaxy" vermeiden, Marke voranstellen
  name = name.replace(new RegExp(`^(${brand}\\s+)+`, "i"), "");
  return brand && name ? `${brand} ${name}` : name || brand;
}

/** Windows: BIOS-Felder direkt aus der Registry (schnell, ohne PowerShell). */
function readWindowsBios() {
  return new Promise(resolve => {
    execFile("reg", ["query", "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS"], { timeout: 10_000, windowsHide: true }, (err, out) => {
      const v = {};
      if (!err) for (const line of String(out).split(/\r?\n/)) {
        const m = /^\s+(\w+)\s+REG_\w+\s+(.*)$/.exec(line);
        if (m) v[m[1]] = m[2].trim();
      }
      resolve(v);
    });
  });
}

module.exports = { marketingName, readWindowsBios, samsungFromCode };
