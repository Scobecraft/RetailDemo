// Reiter "Energielabel": Produkt scannen (QR auf dem EU-Label oder Barcode) bzw. Modell eingeben und das
// offizielle EU-Energieeffizienzlabel finden. Quellen: EPREL (offiziell), Hersteller, Expert, MediaMarkt/Saturn.
"use strict";

const LB = { built: false, qr: null, scanning: false, input: null, result: null, hasKey: false };

const LB_CLASS_COLORS = { A: "#00843d", B: "#4cb847", C: "#bfd730", D: "#fef200", E: "#f9ae1a", F: "#ec6608", G: "#e30613" };
const lbClassColor = c => LB_CLASS_COLORS[String(c || "").trim().toUpperCase().replace(/[^A-G]/g, "").charAt(0)] || "#64748b";

function showLabel(on) {
  if (!on) { lbStopScan(); return; }
  if (!LB.built) lbBuild();
  lbLoadConfig();
}

function lbBuild() {
  const page = $("[data-page=label]");
  LB.input = el("input", { type: "text", placeholder: "z. B. Samsung GQ65S90C oder EAN-Nummer",
    onkeydown: e => { if (e.key === "Enter") lbLookup({ q: LB.input.value }); } });
  LB.result = el("div", { class: "lb-out" }, el("p", { class: "muted" }, "Noch nichts gescannt."));
  page.replaceChildren(
    el("div", { class: "row" }, el("div", {}, el("h2", {}, "Energielabel"),
      el("p", { class: "sub" }, "Produkt scannen oder Modell eingeben – das offizielle EU-Energielabel wird aus vertrauenswürdigen Quellen gesucht (EPREL, Hersteller, Expert, MediaMarkt/Saturn)."))),
    el("div", { class: "lb-grid" },
      el("div", { class: "panel lb-scanpanel" },
        el("h3", {}, "Scannen"),
        el("div", { id: "lbReader", class: "lb-reader" }, el("span", { class: "muted" }, "Kamera aus")),
        el("div", { class: "row", style: "gap:8px;margin-top:8px" },
          el("button", { class: "btn primary", id: "lbScanBtn", onclick: lbToggleScan }, "📷 Kamera starten")),
        el("p", { class: "muted", style: "font-size:12px;margin:6px 0 0" }, "Den QR-Code auf dem EU-Energielabel scannen (führt direkt zum offiziellen Eintrag) oder den Produkt-Barcode/EAN."),
        el("div", { class: "lb-manual" },
          el("label", {}, "oder Modell / EAN eingeben"),
          LB.input,
          el("button", { class: "btn", onclick: () => lbLookup({ q: LB.input.value }) }, "Suchen")),
        el("div", { class: "lb-upload" },
          el("label", {}, "Label-Bild \u2192 druckfertiges PDF (7 \u00d7 14 cm)"),
          el("input", { type: "file", accept: "image/*", onchange: e => { const f = e.target.files && e.target.files[0]; if (f) lbPdfFromFile(f); e.target.value = ""; } }),
          el("p", { class: "muted", style: "font-size:12px;margin:4px 0 0" }, "Ein vorhandenes Label-Bild hochladen \u2013 es wird auf exakt 7 \u00d7 14 cm mit Schnittrand als druckfertiges PDF gespeichert."))),
      el("div", { class: "panel" }, LB.result)),
    lbKeyPanel());
  LB.built = true;
}

// ----------------------------------------------------------- Kamera / Scannen
function lbToggleScan() { LB.scanning ? lbStopScan() : lbStartScan(); }

function lbStartScan() {
  if (typeof Html5Qrcode === "undefined") { toast("Scanner konnte nicht geladen werden (keine Internetverbindung?)"); return; }
  const reader = $("#lbReader"); if (reader) reader.textContent = "";
  try { LB.qr = new Html5Qrcode("lbReader", { verbose: false }); }
  catch (e) { toast("Scanner-Fehler: " + e.message); return; }
  LB.scanning = true;
  const btn = $("#lbScanBtn"); if (btn) { btn.textContent = "⏹ Stopp"; btn.classList.add("danger"); }
  LB.qr.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 240, height: 240 } },
    text => { lbOnScan(text); },
    () => {}).catch(e => {
      LB.scanning = false;
      const b = $("#lbScanBtn"); if (b) { b.textContent = "📷 Kamera starten"; b.classList.remove("danger"); }
      toast("Kamera nicht verfügbar / nicht erlaubt: " + (e && e.message ? e.message : e));
    });
}

function lbStopScan() {
  const btn = $("#lbScanBtn"); if (btn) { btn.textContent = "📷 Kamera starten"; btn.classList.remove("danger"); }
  LB.scanning = false;
  if (LB.qr) { LB.qr.stop().then(() => LB.qr.clear()).catch(() => {}); LB.qr = null; }
}

function lbOnScan(text) {
  lbStopScan();
  if (navigator.vibrate) try { navigator.vibrate(60); } catch (e) {}
  const m = String(text).match(/eprel\.ec\.europa\.eu\/(?:qr\/|screen\/product\/([^/]+)\/)?([0-9]{4,})/i);
  if (m) lbLookup({ reg: m[2], group: m[1] || "", scannedUrl: text });
  else lbLookup({ q: text });
}

// ----------------------------------------------------------- Nachschlagen
async function lbLookup({ q = "", reg = "", group = "", scannedUrl = "" }) {
  const term = (q || reg || "").trim();
  if (!term) { toast("Bitte Modell, EAN oder QR scannen"); return; }
  if (LB.input && q) LB.input.value = q;
  LB.result.replaceChildren(el("p", { class: "muted" }, "Suche …"));
  let data;
  try {
    const qs = new URLSearchParams(); if (q) qs.set("q", q); if (reg) qs.set("reg", reg); if (group) qs.set("group", group);
    data = await api("/api/admin/eprel/lookup?" + qs.toString());
  } catch (e) { LB.result.replaceChildren(el("p", { class: "muted" }, e.message)); return; }
  lbRender(data, { reg, group, scannedUrl });
}

function lbRender(data, ctx) {
  const kids = [el("h3", {}, "Ergebnis für „" + (data.query || "") + "“")];
  const eprelLink = (data.links || []).find(l => /EPREL/i.test(l.name));
  const storeLinks = (data.links || []).filter(l => !/EPREL/i.test(l.name));
  const hasEprel = (data.results && data.results.length) || ctx.scannedUrl || ctx.reg;

  // Direkt gescanntes offizielles EU-Label (QR) – immer anbieten, auch ohne EPREL-Schlüssel
  if (ctx.scannedUrl || ctx.reg) {
    const page = ctx.scannedUrl && /eprel\.ec\.europa\.eu/i.test(ctx.scannedUrl)
      ? ctx.scannedUrl
      : (ctx.group ? `https://eprel.ec.europa.eu/screen/product/${ctx.group}/${ctx.reg}` : `https://eprel.ec.europa.eu/qr/${ctx.reg}`);
    kids.push(el("div", { class: "lb-official" },
      el("b", {}, "✅ Offizielles EU-Label (EPREL)"),
      el("div", { class: "muted", style: "font-size:12px" }, "Registriernummer " + ctx.reg),
      el("a", { class: "btn primary small", href: page, target: "_blank", rel: "noopener" }, "Offizielles Label öffnen")));
  }

  // EPREL-Treffer (mit Schlüssel) – die bevorzugte Quelle
  if (data.results && data.results.length) {
    for (const p of data.results) kids.push(lbCard(p));
  } else if (data.error) {
    kids.push(el("p", { class: "muted" }, "EPREL: " + data.error));
  }

  // EPREL ist immer die erste Wahl: offizielle EPREL-Suche zuerst anbieten.
  if (!hasEprel && eprelLink) {
    kids.push(el("div", { class: "lb-official" },
      el("b", {}, "Bei EPREL suchen (offizielle EU-Datenbank)"),
      el("a", { class: "btn primary small", href: eprelLink.url, target: "_blank", rel: "noopener" }, "EPREL öffnen"),
      !data.has_key ? el("div", { class: "muted", style: "font-size:12px" }, "Tipp: Mit kostenlosem EPREL-Schlüssel (unten) erscheint Klasse + Label hier automatisch.") : null));
  }

  // Nur wenn EPREL nichts hat: zuerst Expert, dann die anderen vertrauenswürdigen Quellen.
  if (!hasEprel && storeLinks.length) {
    kids.push(el("div", { class: "lb-links" },
      el("div", { class: "muted", style: "font-size:12px;margin-bottom:4px" }, "Falls bei EPREL nicht vorhanden – zuerst bei Expert, sonst:"),
      ...storeLinks.map((l, idx) => el("a", { class: "btn small" + (idx === 0 ? " primary" : ""), href: l.url, target: "_blank", rel: "noopener" }, l.name))));
  }
  LB.result.replaceChildren(...kids);
}

function lbCard(p) {
  const badge = el("div", { class: "lb-badge", style: `background:${lbClassColor(p.energyClass)}` }, p.energyClass || "?");
  const info = el("div", {},
    el("b", {}, [p.brand, p.model].filter(Boolean).join(" ") || "Produkt"),
    el("div", { class: "muted", style: "font-size:12px" }, "EPREL " + (p.registrationNumber || "")),
    el("div", { class: "lb-cardlinks" },
      p.page ? el("a", { class: "btn small", href: p.page, target: "_blank", rel: "noopener" }, "EPREL-Seite") : null,
      p.labelProxy ? el("a", { class: "btn small", href: p.labelProxy, target: "_blank", rel: "noopener" }, "Label öffnen") : null,
      p.labelProxy ? el("button", { class: "btn small primary", onclick: () => lbMakePdf(p.labelProxy, [p.brand, p.model].filter(Boolean).join("_") || p.registrationNumber) }, "📄 PDF 7×14 cm") : null));
  const card = el("div", { class: "lb-card" }, badge, info);
  if (p.labelProxy) {
    const img = el("img", { class: "lb-labelimg", src: p.labelProxy, alt: "Energielabel",
      onerror: () => img.remove() });
    return el("div", {}, card, img);
  }
  return card;
}

// ----------------------------------------------------------- EPREL-Schlüssel
function lbKeyPanel() {
  const inp = el("input", { type: "password", placeholder: LB.hasKey ? "Neuer Schlüssel (leer = unverändert)" : "EPREL-API-Schlüssel", autocomplete: "off" });
  return el("div", { class: "panel lb-key", id: "lbKeyPanel" },
    el("h3", {}, "EPREL-API-Schlüssel (optional)"),
    el("p", { class: "muted", style: "font-size:12px;margin:0 0 6px" },
      "Mit einem kostenlosen Schlüssel der EU-Datenbank EPREL holt der Server automatisch Energieklasse + Label. "
      + (LB.hasKey ? "✅ Schlüssel ist hinterlegt." : "Noch kein Schlüssel.")),
    el("a", { href: "https://eprel.ec.europa.eu/screen/api-registration", target: "_blank", rel: "noopener", style: "font-size:12px" }, "Schlüssel kostenlos registrieren ↗"),
    el("div", { class: "row", style: "gap:6px;margin-top:6px" }, inp,
      el("button", { class: "btn small primary", onclick: () => lbSaveKey(inp.value) }, "Speichern"),
      LB.hasKey ? el("button", { class: "btn small danger", onclick: () => lbSaveKey("") }, "Entfernen") : null));
}

async function lbLoadConfig() {
  try { const c = await api("/api/admin/eprel/config"); LB.hasKey = !!c.has_key; }
  catch (e) { LB.hasKey = false; }
  const panel = $("#lbKeyPanel"); if (panel) panel.replaceWith(lbKeyPanel());
}

async function lbSaveKey(key) {
  try { const r = await api("/api/admin/eprel/key", json("PUT", { key }));
    LB.hasKey = !!r.has_key; toast(r.has_key ? "Schlüssel gespeichert" : "Schlüssel entfernt");
    const panel = $("#lbKeyPanel"); if (panel) panel.replaceWith(lbKeyPanel()); }
  catch (e) { toast(e.message); }
}

// ----------------------------------------------------------- PDF (7 × 14 cm, mit Schnittrand)
const LB_W = 70, LB_H = 140; // mm

function lbLoadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous";
    i.onload = () => res(i); i.onerror = () => rej(new Error("Bild konnte nicht geladen werden")); i.src = src; });
}

async function lbToPng(src) {
  const img = await lbLoadImg(src);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth || 700; c.height = img.naturalHeight || 1400;
  c.getContext("2d").drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}

async function lbMakePdf(src, name) {
  const J = window.jspdf && window.jspdf.jsPDF;
  if (!J) { toast("PDF-Bibliothek nicht geladen (keine Internetverbindung?)"); return; }
  let png;
  try { png = await lbToPng(src); }
  catch (e) { toast("Label-Bild nicht verfügbar (bei EPREL evtl. nur als PDF) – dort direkt herunterladen."); return; }
  const doc = new J({ unit: "mm", format: "a4", orientation: "portrait" });
  const pw = 210, ph = 297, x = (pw - LB_W) / 2, y = (ph - LB_H) / 2;
  doc.addImage(png, "PNG", x, y, LB_W, LB_H, undefined, "SLOW");
  // Schnittrand (genau 7 × 14 cm)
  doc.setDrawColor(0); doc.setLineWidth(0.3); doc.rect(x, y, LB_W, LB_H);
  // Schnittmarken an den Ecken (nach außen)
  doc.setLineWidth(0.2); const m = 4;
  const corners = [[x, y, -1, -1], [x + LB_W, y, 1, -1], [x, y + LB_H, -1, 1], [x + LB_W, y + LB_H, 1, 1]];
  for (const [cx, cy, hx, vy] of corners) { doc.line(cx, cy, cx + hx * m, cy); doc.line(cx, cy, cx, cy + vy * m); }
  doc.setFontSize(7); doc.setTextColor(130);
  doc.text("7 × 14 cm · an der Umrandung gerade schneiden", pw / 2, y + LB_H + 7, { align: "center" });
  doc.save((String(name || "energielabel").replace(/[^\w.-]+/g, "_")) + "_7x14cm.pdf");
  toast("PDF erstellt (7 × 14 cm)");
}

function lbPdfFromFile(file) {
  const r = new FileReader();
  r.onload = () => lbMakePdf(r.result, (file.name || "label").replace(/\.[^.]+$/, ""));
  r.onerror = () => toast("Datei konnte nicht gelesen werden");
  r.readAsDataURL(file);
}
