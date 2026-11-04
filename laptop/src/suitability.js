// "Wofür eignet sich der Laptop?" – Bewertung aus den Spec-Texten (Prozessor, Grafik, RAM, SSD, Display, Akku).
// Liefert je Kategorie 1–5 Punkte. Werte lassen sich in den Specs überschreiben, z. B. "Gaming: 5"
// oder "Ideal für: Kreativ" (diese Zeilen erscheinen dann nicht als Spec-Karte).
const CATEGORIES = [
  { key: "office", label: "Office & Schule", sub: "Texte, Tabellen, Surfen, Streaming", re: /^(office|büro|buero|schule)/i },
  { key: "gaming", label: "Gaming", sub: "Aktuelle Spiele, hohe Bildraten", re: /^(gaming|spiele|zocken)/i },
  { key: "creative", label: "Kreativ", sub: "Foto, Video, Design", re: /^(kreativ|creative|foto|video|design)/i },
  { key: "mobile", label: "Unterwegs", sub: "Akkulaufzeit, Größe, Effizienz", re: /^(unterwegs|mobil|reise)/i },
];
const VERDICT = { 5: "Perfekt", 4: "Sehr gut", 3: "Gut", 2: "Geht so", 1: "Eher nicht" };
const IDEAL_RE = /^ideal\s*f(ü|ue)r/i;

const num = s => parseFloat(String(s).replace(",", "."));
const clamp = v => Math.max(0, Math.min(100, v));
const find = (specs, re) => (specs.find(s => re.test(s.label || "")) || {}).value || "";

// ---------------------------------------------------------------- Einzelwerte (0–100)
function cpuScore(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  let v;
  if (/apple m\d+ max|m\d+ max/.test(t)) v = 97;
  else if (/apple m\d+ pro|m\d+ pro/.test(t)) v = 88;
  else if (/apple m(\d+)/.test(t)) v = 70 + Math.min(4, +/apple m(\d+)/.exec(t)[1]) * 3;
  else if (/ultra 9|core 9|i9|ryzen (ai )?9/.test(t)) v = 93;
  else if (/ultra 7|core 7|i7|ryzen (ai )?7|snapdragon x elite/.test(t)) v = 80;
  else if (/ultra 5|core 5|i5|ryzen (ai )?5|snapdragon x plus|snapdragon x\b/.test(t)) v = 66;
  else if (/i3|core 3|ryzen 3/.test(t)) v = 46;
  else if (/celeron|pentium|athlon|processor n|\bn\d{2,3}\b|silver|mediatek|7c/.test(t)) v = 24;
  else v = 55;
  if (/\d+hx\b|\bhx\b/.test(t)) v += 8;                       // Hochleistungs-CPU für Gaming-Laptops
  // ältere Generationen etwas abwerten
  const intel = /i[3579]-(\d{4,5})/.exec(t);
  if (intel) { const gen = intel[1].length === 5 ? +intel[1].slice(0, 2) : +intel[1][0]; if (gen < 10) v -= 12; else if (gen < 12) v -= 5; }
  const ryzen = /ryzen \d (\d)\d{3}/.exec(t);
  if (ryzen) { if (+ryzen[1] <= 3) v -= 10; else if (+ryzen[1] <= 5) v -= 4; }
  const cores = /(\d+)\s*kerne/.exec(t);
  if (cores) { if (+cores[1] >= 14) v += 4; else if (+cores[1] <= 4) v -= 6; }
  return clamp(v);
}

function gpuScore(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  const apple = /(\d+)-kern-gpu/.exec(t);
  if (apple) { const c = +apple[1]; return c >= 30 ? 85 : c >= 16 ? 65 : c >= 10 ? 45 : 38; }
  if (/rtx\s*(50|40)(90|80)/.test(t)) return 100;
  if (/rtx\s*(50|40)70|rtx\s*30(80|70)/.test(t)) return 88;
  if (/rtx\s*(50|40)60|rtx\s*3060/.test(t)) return 78;
  if (/rtx\s*(50|40)50|rtx\s*30[5]0|rtx\s*2060/.test(t)) return 62;
  if (/gtx|rtx\s*20/.test(t)) return 50;
  if (/rx\s*(7[6-9]|6[7-8])\d\d/.test(t)) return 80;
  if (/rx\s*\d{4}/.test(t)) return 60;
  if (/arc a\d{3}m/.test(t)) return 55;
  if (/radeon\s*(8[89]0m|7[89]0m)/.test(t)) return 42;
  if (/arc/.test(t)) return 36;
  if (/adreno/.test(t)) return 30;
  if (/iris xe/.test(t)) return 24;
  if (/uhd|hd graphics/.test(t)) return 10;
  if (/radeon/.test(t)) return 22;
  return 25;
}

function ramScore(s) {
  const m = /(\d+)\s*gb/i.exec(s || "");
  if (!m) return null;
  const gb = +m[1];
  return gb >= 64 ? 100 : gb >= 32 ? 90 : gb >= 24 ? 80 : gb >= 16 ? 70 : gb >= 12 ? 55 : gb >= 8 ? 40 : 15;
}

function storageScore(s) {
  const m = /(\d+(?:[.,]\d)?)\s*(tb|gb)/i.exec(s || "");
  if (!m) return null;
  const gb = num(m[1]) * (/tb/i.test(m[2]) ? 1000 : 1);
  return gb >= 2000 ? 100 : gb >= 1000 ? 85 : gb >= 500 ? 65 : gb >= 250 ? 45 : gb >= 120 ? 20 : 10;
}

function display(s) {
  const t = (s || "").toLowerCase();
  const inch = /(\d+(?:[.,]\d)?)\s*("|zoll|inch)/.exec(t);
  const res = /(\d{3,4})\s*[×x]\s*(\d{3,4})/.exec(t);
  const hz = /(\d{2,3})\s*hz/.exec(t);
  return {
    inch: inch ? num(inch[1]) : null,
    width: res ? +res[1] : null,
    hz: hz ? +hz[1] : 60,
    premium: /oled|retina|xdr|mini-?led|3k|4k/.test(t),
  };
}

function batteryScore(s) {
  const m = /(\d+)\s*wh/i.exec(s || "");
  if (!m) return null;
  const wh = +m[1];
  return wh >= 70 ? 95 : wh >= 60 ? 80 : wh >= 50 ? 65 : wh >= 40 ? 45 : 25;
}

// ---------------------------------------------------------------- Kategorien
const stars = v => (v >= 80 ? 5 : v >= 65 ? 4 : v >= 48 ? 3 : v >= 30 ? 2 : 1);
const or = (v, d) => (v == null ? d : v);

/**
 * @param specs     angezeigte Specs (eigene Specs haben Vorrang)
 * @param fallback  automatisch erkannte Specs, falls in specs etwas fehlt
 * @returns { specs: Specs ohne Bewertungs-Zeilen, suitability: { items:[…], best } | null }
 */
function rate(specs, fallback = []) {
  const overrides = {};
  let ideal = null;
  const rest = [];
  for (const s of specs || []) {
    const label = (s.label || "").trim();
    const cat = CATEGORIES.find(c => c.re.test(label));
    if (cat && /^[1-5]/.test(String(s.value).trim())) { overrides[cat.key] = +String(s.value).trim()[0]; continue; }
    if (IDEAL_RE.test(label)) { ideal = CATEGORIES.find(c => c.re.test(String(s.value).trim())) || null; continue; }
    rest.push(s);
  }
  const all = [...rest, ...(fallback || [])];
  const cpu = cpuScore(find(all, /prozessor|cpu|chip/i));
  const gpu = gpuScore(find(all, /grafik|gpu/i));
  const ram = ramScore(find(all, /arbeitsspeicher|ram|memory/i));
  const stor = storageScore(find(all, /^speicher|ssd|festplatte|storage/i));
  const disp = display(find(all, /display|bildschirm/i));
  const bat = batteryScore(find(all, /akku|batter/i));
  if (cpu == null && gpu == null && ram == null && !Object.keys(overrides).length) return { specs: rest, suitability: null };

  const C = or(cpu, 55), G = or(gpu, 25), R = or(ram, 50), S = or(stor, 50);
  const hzScore = disp.hz >= 144 ? 100 : disp.hz >= 120 ? 75 : 40;
  const dispScore = disp.premium || (disp.width || 0) >= 2560 ? 90 : (disp.inch || 0) >= 15 ? 60 : 45;
  const sizeScore = disp.inch == null ? 60 : disp.inch <= 13.6 ? 100 : disp.inch <= 14.5 ? 90 : disp.inch <= 15.6 ? 55 : disp.inch <= 16.5 ? 45 : 20;
  const cpuText = find(all, /prozessor|cpu|chip/i).toLowerCase();
  const eff = /apple m|snapdragon|ultra \d \d{3}v/.test(cpuText) ? 95 : /\d+(hx|hs|h)\b/.test(cpuText) ? 35 : 65;

  const score = {
    office: Math.min(100, 10 + Math.min(C, 85) / 85 * 45 + Math.min(R, 70) / 70 * 35 + Math.min(S, 65) / 65 * 20),
    gaming: G * .65 + C * .15 + R * .1 + hzScore * .1,
    creative: C * .3 + G * .25 + R * .2 + dispScore * .15 + S * .1,
    // starke Grafikkarte = schwer und stromhungrig
    mobile: or(bat, 50) * .4 + eff * .3 + sizeScore * .3 - (G >= 60 ? 10 : 0),
  };
  const items = CATEGORIES.map(c => {
    const st = overrides[c.key] || stars(score[c.key]);
    return { key: c.key, label: c.label, sub: c.sub, stars: st, verdict: VERDICT[st], score: Math.round(score[c.key]) };
  });
  // "Ideal für": Office schaffen fast alle Laptops – daher die stärkste andere Kategorie mit mind. 4 Punkten
  // (bei Gleichstand Gaming > Kreativ > Unterwegs), sonst Office
  const prio = { gaming: 3, creative: 2, mobile: 1 };
  const special = items.filter(i => i.key !== "office" && i.stars >= 4)
    .sort((a, b) => b.stars - a.stars || prio[b.key] - prio[a.key] || b.score - a.score)[0];
  const best = ideal ? items.find(i => i.key === ideal.key) : special || items.find(i => i.key === "office");
  return { specs: rest, suitability: { items, best: best.key } };
}

module.exports = { rate, CATEGORIES };
