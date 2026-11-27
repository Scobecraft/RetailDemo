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
          el("button", { class: "btn", onclick: () => lbLookup({ q: LB.input.value }) }, "Suchen"))),
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

  // EPREL-Treffer (nur mit Schlüssel)
  if (data.results && data.results.length) {
    for (const p of data.results) kids.push(lbCard(p));
  } else if (data.error) {
    kids.push(el("p", { class: "muted" }, "EPREL: " + data.error));
  } else if (!data.has_key && !(ctx.scannedUrl || ctx.reg)) {
    kids.push(el("p", { class: "muted", style: "font-size:13px" },
      "Für die automatische Anzeige von Energieklasse + Label aus EPREL einen kostenlosen EPREL-API-Schlüssel unten eintragen. Ohne Schlüssel die vertrauenswürdigen Links nutzen:"));
  }

  // Vertrauenswürdige Schnell-Links
  if (data.links && data.links.length) {
    kids.push(el("div", { class: "lb-links" },
      el("div", { class: "muted", style: "font-size:12px;margin-bottom:4px" }, "Bei vertrauenswürdigen Quellen nachsehen:"),
      ...data.links.map(l => el("a", { class: "btn small", href: l.url, target: "_blank", rel: "noopener" }, l.name))));
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
      p.labelProxy ? el("a", { class: "btn small primary", href: p.labelProxy, target: "_blank", rel: "noopener" }, "Label öffnen") : null));
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
