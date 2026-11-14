// Reiter "3D-Drucker": Live-Dashboard aus den Daten der Druckmonitor-App (Drucker + PC).
// Wird einmal aufgebaut und danach alle 2 s nur mit neuen Werten versorgt.
// Nutzt $, el, api und tweenNumber aus index.html.
"use strict";

const DK = {
  built: false, refs: {}, hist: [], lastT: 0, timer: null, busy: false, visible: false,
  camSeq: 0, camRun: 0, viewer: null, viewerRev: null, viewerLoading: false, data: null,
};
const DK_HIST_MAX = 720;

// ---------------------------------------------------------------- Formatierung
const dkNum = (v, d = 0) => v == null || isNaN(v) ? "–" : Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
function dkBytes(b, d = 1) {
  if (b == null || b < 0) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${dkNum(b, i ? d : 0)} ${u[i]}`;
}
const dkRate = b => b == null || b < 0 ? "–" : dkBytes(b) + "/s";
// Netzwerk üblicherweise in Bit/s
function dkBits(bps) {
  if (bps == null || bps < 0) return "–";
  let v = bps * 8; const u = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"]; let i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${dkNum(v, v < 10 && i ? 1 : 0)} ${u[i]}`;
}
function dkDur(sec) {
  if (sec == null || sec < 0) return "–";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  if (h >= 24) return `${Math.floor(h / 24)} T. ${h % 24} Std.`;
  return h ? `${h} Std. ${m} Min.` : m ? `${m} Min.` : `${sec % 60} Sek.`;
}
const dkClock = t => new Date(t * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const dkPct = v => v == null || v < 0 ? "–" : `${dkNum(v)} %`;

const DK_STATE = {
  printing: ["Druckt", "run"], heating: ["Heizt auf", "warm"], paused: ["Pausiert", "warn"], done: ["Fertig", "ok"],
  idle: ["Bereit", "idle"], busy: ["Beschäftigt", "warm"], error: ["Fehler", "bad"], offline: ["Drucker offline", "bad"],
};

// ---------------------------------------------------------------- Aufbau
function dkCard(span, title, ...body) {
  const h = title ? el("div", { class: "dk-card-head" }, el("h3", {}, title)) : null;
  return el("section", { class: `dk-card ${span}` }, h, ...body);
}
function dkStat(label) {
  const v = el("div", { class: "dk-stat-v" }, "–"), n = el("div", { class: "dk-stat-n" });
  return { node: el("div", { class: "dk-stat" }, el("div", { class: "dk-stat-l" }, label), v, n), v, n };
}
function dkMeter(label) {
  const pct = el("span", { class: "dk-meter-pct" }, "–"), detail = el("span", { class: "dk-meter-d" });
  const fill = el("div", { class: "dk-meter-fill" }), spark = el("div", { class: "dk-spark" });
  const note = el("div", { class: "dk-meter-note" });
  const node = el("section", { class: "dk-card span-3 dk-meter" },
    el("div", { class: "dk-meter-top" }, el("h3", {}, label), detail),
    pct, el("div", { class: "dk-meter-track" }, fill), note, spark);
  return { node, pct, detail, fill, spark, note };
}
function dkLegend(series) {
  return el("div", { class: "legend" }, ...series.map(s => el("span", {},
    el("i", { style: `background:${s.color}` + (s.dash ? ";opacity:.6" : "") }), s.name)));
}

function dkBuild() {
  const R = DK.refs;
  const page = $("[data-page=druck]");
  R.sub = el("span", { class: "dk-sub" });
  R.live = el("span", { class: "live lost" }, el("i"), el("span", {}, "Verbinde …"));
  const fullBtn = el("button", { class: "btn small", onclick: () => { const f = R.camBox; (f.requestFullscreen || f.webkitRequestFullscreen)?.call(f); } }, "Kamera im Vollbild");
  const progBtn = el("a", { class: "btn small", href: "/druck/monitor", target: "_blank", rel: "noopener" }, "Programm-Ansicht");

  // --- Hero: Status, Fortschrittsring, Zeiten
  const C = 2 * Math.PI * 54;
  R.ringC = C;
  R.ring = el("circle", {});
  const svgNS = "http://www.w3.org/2000/svg";
  const ring = document.createElementNS(svgNS, "svg");
  ring.setAttribute("viewBox", "0 0 128 128"); ring.setAttribute("class", "dk-ring");
  for (const [cls, extra] of [["dk-ring-bg", {}], ["dk-ring-fg", { "stroke-dasharray": C, "stroke-dashoffset": C }]]) {
    const c = document.createElementNS(svgNS, "circle");
    Object.entries({ cx: 64, cy: 64, r: 54, class: cls, ...extra }).forEach(([k, v]) => c.setAttribute(k, v));
    ring.append(c);
    if (cls === "dk-ring-fg") R.ring = c;
  }
  R.ringPct = el("div", { class: "dk-ring-pct" }, "–");
  R.ringLayer = el("div", { class: "dk-ring-sub" }, "");
  R.state = el("span", { class: "dk-state idle" }, el("i"), el("span", {}, "–"));
  R.model = el("div", { class: "dk-model" }, "–");
  R.fileLine = el("div", { class: "dk-fileline" });
  R.bar = el("div", { class: "dk-bar-fill" });
  R.left = dkStat("Restzeit"); R.eta = dkStat("Fertig um"); R.elapsed = dkStat("Verstrichen"); R.total = dkStat("Druckzeit gesamt");
  const hero = el("section", { class: "dk-card span-12 dk-hero" },
    el("div", { class: "dk-hero-main" }, R.state, R.model, R.fileLine),
    el("div", { class: "dk-ring-box" }, ring, el("div", { class: "dk-ring-text" }, R.ringPct, R.ringLayer)),
    el("div", { class: "dk-hero-stats" }, R.left.node, R.eta.node, R.elapsed.node, R.total.node),
    el("div", { class: "dk-bar" }, R.bar));

  // --- Kamera und Modell
  R.cam = el("canvas", { class: "dk-cam", width: 1280, height: 720 });
  R.camMsg = el("div", { class: "dk-cam-msg" }, "Warte auf Kamerabild …");
  R.camBadge = el("span", { class: "dk-cam-badge" }, "");
  R.camBox = el("div", { class: "dk-cam-box" }, R.cam, R.camMsg, R.camBadge);
  const camCard = dkCard("span-7", "Kamera", R.camBox);
  R.modelCanvas = el("canvas", { class: "dk-3d" });
  R.modelMsg = el("div", { class: "dk-cam-msg" }, "Kein Modell");
  R.modelInfo = el("div", { class: "dk-model-info" });
  const modelCard = dkCard("span-5", "Aktuelles Modell", el("div", { class: "dk-3d-box" }, R.modelCanvas, R.modelMsg), R.modelInfo);

  // --- Temperaturen
  R.tempChart = el("div", { class: "chart-wrap" });
  const tempSeries = [{ name: "Düse", color: "var(--s2)" }, { name: "Druckbett", color: "var(--s1)" }];
  const tempCard = dkCard("span-8", "Temperaturen", R.tempChart);
  tempCard.querySelector(".dk-card-head").append(el("div", { class: "legend" },
    ...tempSeries.map(s => el("span", {}, el("i", { style: `background:${s.color}` }), s.name)),
    el("span", { class: "muted" }, el("i", { class: "dk-dash" }), "Zieltemperatur")));
  R.nozzle = dkStat("Düse"); R.bedT = dkStat("Druckbett"); R.fan = dkStat("Lüfter"); R.speed = dkStat("Geschwindigkeit");
  R.nozzleBar = el("div", { class: "dk-mini-fill", style: "background:var(--s2)" });
  R.bedBar = el("div", { class: "dk-mini-fill", style: "background:var(--s1)" });
  R.nozzle.node.append(el("div", { class: "dk-mini" }, R.nozzleBar));
  R.bedT.node.append(el("div", { class: "dk-mini" }, R.bedBar));
  const nowCard = dkCard("span-4", "Jetzt", el("div", { class: "dk-stat-grid" }, R.nozzle.node, R.bedT.node, R.fan.node, R.speed.node));

  // --- Fortschritt und Druckdaten
  R.progChart = el("div", { class: "chart-wrap" });
  const progCard = dkCard("span-6", "Fortschritt", R.progChart);
  R.details = el("dl", { class: "dk-dl" });
  const detailCard = dkCard("span-6", "Druckdaten", R.details);

  // --- PC
  R.pcTitle = el("h2", {}, "PC");
  R.pcSub = el("span", { class: "dk-sub" });
  R.pcHint = el("div", { class: "dk-card span-12 muted", hidden: true },
    "Für PC-Werte bitte die neue Version der Druckmonitor-App installieren.");
  R.cpu = dkMeter("Prozessor"); R.ram = dkMeter("Arbeitsspeicher"); R.gpu = dkMeter("Grafikkarte"); R.vram = dkMeter("Grafikspeicher");
  R.cpu.fill.style.background = "var(--s1)"; R.ram.fill.style.background = "var(--s2)"; R.gpu.fill.style.background = "var(--s3)"; R.vram.fill.style.background = "var(--s3)";
  R.loadChart = el("div", { class: "chart-wrap" });
  const loadSeries = [{ name: "CPU", color: "var(--s1)" }, { name: "RAM", color: "var(--s2)" }, { name: "GPU", color: "var(--s3)" }];
  const loadCard = dkCard("span-8", "Auslastung", R.loadChart);
  loadCard.querySelector(".dk-card-head").append(dkLegend(loadSeries));
  R.cores = el("div", { class: "dk-cores" });
  R.coreTip = el("div", { class: "dk-core-note muted" });
  const coreCard = dkCard("span-4", "Prozessorkerne", R.cores, R.coreTip);
  R.netChart = el("div", { class: "chart-wrap" });
  R.netNow = el("div", { class: "dk-now" });
  const netCard = dkCard("span-6", "Netzwerk", R.netNow, R.netChart);
  netCard.querySelector(".dk-card-head").append(dkLegend([{ name: "Empfangen", color: "var(--s1)" }, { name: "Gesendet", color: "var(--s2)" }]));
  R.disks = el("div", { class: "dk-disks" });
  R.diskNow = el("div", { class: "dk-now" });
  R.diskChart = el("div", { class: "chart-wrap" });
  const diskCard = dkCard("span-6", "Datenträger", R.disks, R.diskNow, R.diskChart);
  diskCard.querySelector(".dk-card-head").append(dkLegend([{ name: "Lesen", color: "var(--s1)" }, { name: "Schreiben", color: "var(--s2)" }]));
  R.procs = el("div", { class: "dk-procs" });
  const procCard = dkCard("span-6", "Prozesse", R.procs);
  R.hw = el("div", { class: "dk-hw" });
  const hwCard = dkCard("span-6", "Verbaute Hardware", R.hw);

  R.pcGrid = el("div", { class: "dk-grid" }, R.cpu.node, R.ram.node, R.gpu.node, R.vram.node, loadCard, coreCard, netCard, diskCard, procCard, hwCard);
  R.foot = el("div", { class: "ov-foot" });

  page.replaceChildren(el("div", { class: "dk ov" },
    el("div", { class: "dk-head" },
      el("div", {}, el("h2", {}, "3D-Drucker"), el("div", { class: "dk-headline" }, R.live, R.sub)),
      el("div", { class: "dk-actions" }, fullBtn, progBtn)),
    el("div", { class: "dk-grid" }, hero, dkJobsCard(), camCard, modelCard, tempCard, nowCard, progCard, detailCard),
    el("div", { class: "dk-head dk-pc-head" }, el("div", {}, R.pcTitle, el("div", { class: "dk-headline" }, R.pcSub))),
    R.pcHint, R.pcGrid, R.foot,
    el("p", { class: "muted druck-help" }, "Die Daten kommen von der Druckmonitor-App auf dem PC beim Drucker (Einstellungen → „Webseite (Retail-Demo-Server)“: Adresse dieses Servers und Geräte-Token). Das Kamerabild läuft flüssig, solange diese Seite offen ist.")));
  // gestaffeltes Einblenden
  page.querySelectorAll(".dk-card").forEach((c, i) => c.style.animationDelay = `${Math.min(i, 14) * 40}ms`);
  DK.built = true;
}

// ---------------------------------------------------------------- Linien-Diagramm (SVG)
// series: [{key, name, color, dash?, label?}] – eine Achse; fmt formatiert Achse/Tooltip.
function dkLineChart(wrap, hist, series, { height = 220, fmt = v => dkNum(v), max = null, min = 0, area = false, empty = "Noch keine Daten" } = {}) {
  const W = Math.round(wrap.clientWidth);
  if (!W) return;
  const pts = hist.filter(p => series.some(s => p[s.key] != null));
  if (pts.length < 2) { wrap.replaceChildren(el("div", { class: "empty dk-empty", style: `height:${height}px` }, empty)); return; }
  const NS = "http://www.w3.org/2000/svg";
  let hi = max ?? Math.max(...pts.flatMap(p => series.map(s => p[s.key] ?? 0)));
  if (max == null) { // runde Obergrenze
    const step = Math.pow(10, Math.floor(Math.log10(hi || 1)));
    hi = Math.ceil((hi || 1) / step * 1.1) * step;
  }
  // Ränder nach der Länge der Beschriftungen (ca. 6,5 px je Zeichen bei 11–12 px Schrift)
  const lastP = pts[pts.length - 1];
  const axisLen = Math.max(...[0, 1, 2, 3, 4].map(i => fmt(min + (hi - min) * i / 4).length));
  const endLen = Math.max(0, ...series.filter(s => !s.dash && lastP[s.key] != null).map(s => `${s.label ?? s.name} ${fmt(lastP[s.key])}`.length));
  const H = height, L = Math.max(36, axisLen * 6.3 + 12), R = Math.max(40, endLen * 7 + 16), T = 10, B = 24;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = t => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R);
  const y = v => T + (1 - (v - min) / Math.max(1e-9, hi - min)) * (H - T - B);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.style.height = H + "px";
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", series.map(s => s.name).join(", ") + ", Verlauf");
  const mk = (tag, attrs, parent = svg) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); parent.append(n); return n; };
  for (let i = 0; i <= 4; i++) {
    const v = min + (hi - min) * i / 4;
    mk("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1 });
    mk("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end", fill: "var(--muted)", "font-size": 11 }).textContent = fmt(v);
  }
  const ticks = W < 500 ? [t0, t1] : [t0, (t0 + t1) / 2, t1];
  for (const t of ticks) mk("text", { x: x(t), y: H - 6, "text-anchor": t === t0 ? "start" : t === t1 ? "end" : "middle", fill: "var(--muted)", "font-size": 11 }).textContent = dkClock(t);
  // Linien; Lücken (fehlende Werte) unterbrechen die Linie
  const pathOf = key => {
    let d = "", pen = false;
    for (const p of pts) {
      const v = p[key];
      if (v == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(Math.min(v, hi)).toFixed(1)}`; pen = true;
    }
    return d;
  };
  for (const s of series) {
    const d = pathOf(s.key);
    if (!d) continue;
    if (area && !s.dash) {
      const first = pts.find(p => p[s.key] != null), last = [...pts].reverse().find(p => p[s.key] != null);
      mk("path", { d: `${d}L${x(last.t).toFixed(1)},${y(min)}L${x(first.t).toFixed(1)},${y(min)}Z`, fill: s.color, opacity: .12, stroke: "none" });
    }
    mk("path", { d, fill: "none", stroke: s.color, "stroke-width": s.dash ? 1.5 : 2, "stroke-dasharray": s.dash ? "5 4" : "none",
      opacity: s.dash ? .7 : 1, "stroke-linejoin": "round", "stroke-linecap": "round" });
  }
  // Direkte Beschriftung am Ende (nur Hauptlinien), mind. 15 px Abstand
  const last = pts[pts.length - 1];
  const ends = series.filter(s => !s.dash && last[s.key] != null).map(s => ({ s, y: y(Math.min(last[s.key], hi)) + 4 })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
  const over = ends.length ? ends[ends.length - 1].y - (H - B + 4) : 0;
  if (over > 0) ends.forEach(e => e.y -= over);
  for (const e of ends) {
    mk("circle", { cx: x(last.t), cy: y(Math.min(last[e.s.key], hi)), r: 4, fill: e.s.color, stroke: "var(--card)", "stroke-width": 2, class: "dk-endpt" });
    mk("text", { x: W - R + 8, y: e.y, fill: "var(--text)", "font-size": 12, "font-weight": 600 }).textContent = `${e.s.label ?? e.s.name} ${fmt(last[e.s.key])}`;
  }
  // Hover: Fadenkreuz + Tooltip
  const cross = mk("line", { y1: T, y2: H - B, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0 });
  const dots = series.map(s => mk("circle", { r: 4.5, fill: s.color, stroke: "var(--card)", "stroke-width": 2, opacity: 0 }));
  mk("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
  const tip = el("div", { class: "tip" });
  wrap.replaceChildren(svg, tip);
  svg.addEventListener("pointermove", e => {
    const vx = (e.clientX - svg.getBoundingClientRect().left) * W / svg.getBoundingClientRect().width;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - vx) < Math.abs(x(best.t) - vx)) best = p;
    const px = x(best.t);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("opacity", 1);
    let top = H;
    series.forEach((s, i) => {
      const v = best[s.key];
      if (v == null) { dots[i].setAttribute("opacity", 0); return; }
      dots[i].setAttribute("cx", px); dots[i].setAttribute("cy", y(Math.min(v, hi))); dots[i].setAttribute("opacity", 1);
      top = Math.min(top, y(Math.min(v, hi)));
    });
    tip.textContent = `${dkClock(best.t)} · ` + series.filter(s => best[s.key] != null).map(s => `${s.name} ${fmt(best[s.key])}`).join(" · ");
    tip.style.left = `${Math.min(Math.max(px * svg.getBoundingClientRect().width / W, 120), wrap.clientWidth - 120)}px`;
    tip.style.top = `${Math.max(top, 40)}px`;
    tip.classList.add("show");
  });
  svg.addEventListener("pointerleave", () => { cross.setAttribute("opacity", 0); dots.forEach(d => d.setAttribute("opacity", 0)); tip.classList.remove("show"); });
}

function dkSpark(box, hist, key, color) {
  const pts = hist.slice(-120).filter(p => p[key] != null);
  if (pts.length < 2) { box.replaceChildren(); return; }
  const W = 200, H = 36, t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = t => (t - t0) / Math.max(1, t1 - t0) * W, y = v => H - 2 - Math.min(100, v) / 100 * (H - 4);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}L${W},${H}L0,${H}Z" fill="${color}" opacity=".14"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------------------------------------------------------------- Aktualisieren
function dkSetLive(ok, text) {
  const l = DK.refs.live;
  l.className = ok ? "live" : "live lost";
  l.lastChild.textContent = text;
}

function dkUpdate(d) {
  const R = DK.refs, live = d.live || {}, file = d.file || {};
  DK.data = d;
  const online = d.online;
  dkSetLive(online, online ? "Live" : "Offline");
  R.sub.textContent = online
    ? `aktualisiert ${new Date(d.last_update * 1000).toLocaleTimeString("de-DE")}`
    : d.last_update ? `Druckmonitor-App sendet nicht – zuletzt vor ${dkDur(d.server_time - d.last_update)}` : "Noch keine Daten von der Druckmonitor-App";

  // Hero
  const st = online ? (DK_STATE[live.state] || [live.status || "Unbekannt", "idle"]) : ["Keine Verbindung", "bad"];
  R.state.className = `dk-state ${st[1]}`;
  R.state.lastChild.textContent = live.status && online && !DK_STATE[live.state] ? live.status : st[0];
  const name = (d.model.name || live.fileName || "").replace(/\.(gcode|gx|3mf|stl|obj|glb)$/i, "").replace(/\.gcode$/i, "");
  R.model.textContent = name || "Kein Druckauftrag";
  const color = file.filamentColor;
  R.fileLine.replaceChildren(
    ...[file.filamentType || live.filamentType, file.filamentName, live.machine, file.slicer].filter(Boolean).map(t => el("span", {}, t)),
    ...(color ? [el("span", { class: "dk-swatch", style: `background:${color}`, title: `Filamentfarbe ${color}` })] : []));
  const prog = online && live.progress >= 0 ? live.progress * 100 : null;
  const active = online && ["printing", "paused", "heating"].includes(live.state);
  R.ring.style.strokeDashoffset = R.ringC * (1 - (prog ?? 0) / 100);
  R.ring.classList.toggle("active", active && live.state === "printing");
  if (prog == null) R.ringPct.textContent = "–"; else tweenNumber(R.ringPct, prog, v => `${dkNum(v)} %`);
  R.ringLayer.textContent = online && live.layers > 0 ? `Schicht ${dkNum(live.layer)} / ${dkNum(live.layers)}` : online && live.layer > 0 ? `Schicht ${dkNum(live.layer)}` : "";
  R.bar.style.width = `${prog ?? 0}%`;
  R.bar.classList.toggle("active", active);
  const left = active && live.remainingSec >= 0 ? live.remainingSec : null;
  R.left.v.textContent = left != null ? dkDur(left) : "–";
  R.left.n.textContent = left != null && live.remainingEst ? "geschätzt aus dem Drucktempo" : "";
  R.eta.v.textContent = left != null ? dkClock(Date.now() / 1000 + left) : "–";
  R.eta.n.textContent = left != null && left > 86400 ? new Date(Date.now() + left * 1000).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }) : "";
  R.elapsed.v.textContent = online && live.elapsedSec >= 0 ? dkDur(live.elapsedSec) : "–";
  R.total.v.textContent = file.timeSec > 0 ? dkDur(file.timeSec) : "–";
  R.total.n.textContent = file.timeSec > 0 ? "laut Slicer" : "";

  // Jetzt
  const tempStat = (s, bar, cur, target, maxT) => {
    s.v.textContent = online && cur > 0 ? `${dkNum(cur)} °C` : "–";
    s.n.textContent = online && target > 0 ? `Ziel ${dkNum(target)} °C` : online ? "aus" : "";
    bar.style.width = online && cur > 0 ? `${Math.min(100, cur / maxT * 100)}%` : "0%";
  };
  tempStat(R.nozzle, R.nozzleBar, live.nozzle, live.nozzleTarget, Math.max(300, live.nozzleTarget || 0));
  tempStat(R.bedT, R.bedBar, live.bed, live.bedTarget, Math.max(120, live.bedTarget || 0));
  R.fan.v.textContent = online && live.fanPct >= 0 ? dkPct(live.fanPct) : "–";
  R.fan.n.textContent = online && live.chamber > 0 ? `Kammer ${dkNum(live.chamber)} °C` : "";
  R.speed.v.textContent = online && live.speedMms > 0 ? `${dkNum(live.speedMms)} mm/s` : online && live.speedPct >= 0 ? dkPct(live.speedPct) : "–";
  R.speed.n.textContent = online && live.speedPct >= 0 && live.speedMms > 0 ? `${dkNum(live.speedPct)} % eingestellt` : "";

  // Druckdaten
  const rows = [
    ["Schichthöhe", file.layerHeight > 0 ? `${dkNum(file.layerHeight, 2)} mm` : null],
    ["Schichten", file.layers > 0 ? dkNum(file.layers) : live.layers > 0 ? dkNum(live.layers) : null],
    ["Füllung", file.infill || null],
    ["Wände", file.walls > 0 ? dkNum(file.walls) : null],
    ["Stützstrukturen", file.supports || null],
    ["Düse", file.nozzleSize > 0 ? `${dkNum(file.nozzleSize, 1)} mm` : null],
    ["Filament", [file.filamentType || live.filamentType, file.filamentName].filter(Boolean).join(" · ") || null],
    ["Filament (Slicer)", file.filamentM > 0 ? `${dkNum(file.filamentM, 1)} m` + (file.filamentG > 0 ? ` · ${dkNum(file.filamentG)} g` : "") : null],
    ["Filament verbraucht", online && live.filamentM > 0 ? `${dkNum(live.filamentM, 1)} m` + (live.filamentG > 0 ? ` · ${dkNum(live.filamentG)} g` : "") : null],
    ["Drucker", [live.machine, live.firmware && `Firmware ${live.firmware}`].filter(Boolean).join(" · ") || null],
    ["Slicer", file.slicer || null],
  ].filter(r => r[1]);
  R.details.replaceChildren(...(rows.length ? rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])
    : [el("div", { class: "muted" }, "Keine Angaben – am meisten zeigt die geslicte Datei aus Flash Studio.")]));

  // Modell
  dkModel(d);

  // Diagramme Drucker
  dkLineChart(R.tempChart, DK.hist, [
    { key: "nozzle", name: "Düse", color: "var(--s2)" }, { key: "bed", name: "Bett", color: "var(--s1)" },
    { key: "nozzle_t", name: "Ziel Düse", color: "var(--s2)", dash: true }, { key: "bed_t", name: "Ziel Bett", color: "var(--s1)", dash: true },
  ], { fmt: v => `${dkNum(v)} °C`, height: 240 });
  dkLineChart(R.progChart, DK.hist, [{ key: "progress", name: "Fortschritt", color: "var(--s1)", label: "" }],
    { fmt: v => `${dkNum(v)} %`, max: 100, area: true, empty: "Läuft gerade kein Druck, bleibt dieses Diagramm leer." });

  dkUpdatePC(d);
  R.foot.textContent = `Verlauf der letzten ${dkDur(DK.hist.length ? d.server_time - DK.hist[0].t : 0)} · Werte alle 2 s, Diagramme alle 5 s`;
}

function dkUpdatePC(d) {
  const R = DK.refs, pc = d.pc, info = d.pc_info;
  R.pcHint.hidden = !!(pc || info) || !d.last_update;
  R.pcGrid.hidden = !(pc || info);
  R.pcTitle.textContent = `PC${(info?.host || pc?.host) ? " · " + (info?.host || pc?.host) : ""}`;
  R.pcSub.textContent = [info?.system, info?.os, pc ? `läuft seit ${dkDur(pc.uptimeSec)}` : null].filter(Boolean).join(" · ");
  if (!pc && !info) return;

  const meter = (m, pct, detail, note) => {
    if (pct == null || pct < 0) { m.pct.textContent = "–"; m.fill.style.width = "0%"; } else { tweenNumber(m.pct, pct, v => `${dkNum(v)} %`); m.fill.style.width = `${Math.min(100, pct)}%`; }
    m.detail.textContent = detail || ""; m.note.textContent = note || "";
    m.node.classList.toggle("hot", pct >= 90);
  };
  const ramPct = pc && pc.ramTotalB ? pc.ramUsedB / pc.ramTotalB * 100 : null;
  meter(R.cpu, pc ? pc.cpuPct : null, info?.cpu ? info.cpu.replace(/\(R\)|\(TM\)|CPU|Processor/gi, "").replace(/\s+/g, " ").trim() : "",
    info?.threads ? `${info.cores} Kerne · ${info.threads} Threads` + (info.cpuMaxMHz ? ` · ${dkNum(info.cpuMaxMHz / 1000, 1)} GHz` : "") : "");
  meter(R.ram, ramPct, pc ? `${dkBytes(pc.ramUsedB)} von ${dkBytes(pc.ramTotalB)}` : "",
    info?.ramModules?.length ? `${info.ramModules.length} Modul${info.ramModules.length > 1 ? "e" : ""}` + (info.ramModules[0].speedMHz ? ` · ${info.ramModules[0].speedMHz} MT/s` : "") : "");
  const g = pc?.gpus?.[0], gi = info?.gpus?.find(x => !/basic|virtual|remote|parsec|meta/i.test(x.name)) || info?.gpus?.[0];
  meter(R.gpu, g ? g.pct : null, g?.name || gi?.name || "", g && g.tempC >= 0 ? `${dkNum(g.tempC)} °C` + (g.powerW >= 0 ? ` · ${dkNum(g.powerW)} W` : "") + (g.fanPct >= 0 ? ` · Lüfter ${dkNum(g.fanPct)} %` : "") : gi?.display || "");
  const vTotal = g?.memTotalB || gi?.vramB || 0;
  meter(R.vram, g && vTotal ? g.memUsedB / vTotal * 100 : null, g && g.memUsedB ? `${dkBytes(g.memUsedB)} von ${vTotal ? dkBytes(vTotal) : "?"}` : vTotal ? dkBytes(vTotal) : "",
    g && g.clockMHz >= 0 ? `Takt ${dkNum(g.clockMHz)} MHz` : "");
  const noGpu = !g && !gi;
  R.gpu.node.hidden = R.vram.node.hidden = noGpu;
  for (const m of [R.cpu, R.ram]) { m.node.classList.toggle("span-3", !noGpu); m.node.classList.toggle("span-6", noGpu); }
  dkSpark(R.cpu.spark, DK.hist, "cpu", "var(--s1)");
  dkSpark(R.ram.spark, DK.hist, "ram", "var(--s2)");
  dkSpark(R.gpu.spark, DK.hist, "gpu", "var(--s3)");
  R.vram.spark.replaceChildren();

  dkLineChart(R.loadChart, DK.hist, [
    { key: "cpu", name: "CPU", color: "var(--s1)" }, { key: "ram", name: "RAM", color: "var(--s2)" }, { key: "gpu", name: "GPU", color: "var(--s3)" },
  ], { fmt: v => `${dkNum(v)} %`, max: 100 });

  // Kerne: ein Balken je Thread (eine Farbe, Höhe = Auslastung)
  const cores = pc?.cores || [];
  if (R.cores.childElementCount !== cores.length) {
    R.cores.replaceChildren(...cores.map((_, i) => el("div", { class: "dk-core", title: `Thread ${i + 1}` }, el("i"))));
    R.cores.style.setProperty("--n", Math.min(16, Math.max(4, Math.ceil(Math.sqrt(cores.length * 2)))));
  }
  cores.forEach((v, i) => { const c = R.cores.children[i]; c.firstChild.style.height = `${Math.max(2, v)}%`; c.title = `Thread ${i + 1}: ${dkNum(v)} %`; });
  if (cores.length) {
    const top = Math.max(...cores);
    R.coreTip.textContent = `${cores.length} Threads · am stärksten ausgelastet: ${dkNum(top)} %`;
  } else R.coreTip.textContent = "Keine Angaben je Kern";

  R.netNow.replaceChildren(
    el("div", {}, el("span", { class: "muted" }, "↓ Empfangen "), el("b", {}, dkBits(pc?.netRxBps))),
    el("div", {}, el("span", { class: "muted" }, "↑ Gesendet "), el("b", {}, dkBits(pc?.netTxBps))));
  dkLineChart(R.netChart, DK.hist, [{ key: "rx", name: "↓", color: "var(--s1)" }, { key: "tx", name: "↑", color: "var(--s2)" }],
    { fmt: v => dkBits(v), height: 180 });

  R.disks.replaceChildren(...(pc?.disks || []).map(dk => {
    const pct = dk.totalB ? dk.usedB / dk.totalB * 100 : 0;
    return el("div", { class: "dk-disk" + (pct >= 90 ? " hot" : "") },
      el("div", { class: "dk-disk-top" }, el("b", {}, dk.mount + (dk.label ? ` ${dk.label}` : "")), el("span", { class: "muted" }, `${dkBytes(dk.totalB - dk.usedB)} frei von ${dkBytes(dk.totalB)}`)),
      el("div", { class: "dk-meter-track" }, el("div", { class: "dk-meter-fill", style: `width:${pct}%` })));
  }));
  R.diskNow.replaceChildren(
    el("div", {}, el("span", { class: "muted" }, "Lesen "), el("b", {}, dkRate(pc?.diskReadBps))),
    el("div", {}, el("span", { class: "muted" }, "Schreiben "), el("b", {}, dkRate(pc?.diskWriteBps))),
    ...(pc && pc.diskBusyPct >= 0 ? [el("div", {}, el("span", { class: "muted" }, "Aktiv "), el("b", {}, dkPct(pc.diskBusyPct)))] : []));
  dkLineChart(R.diskChart, DK.hist, [{ key: "disk_r", name: "Lesen", color: "var(--s1)" }, { key: "disk_w", name: "Schreiben", color: "var(--s2)" }],
    { fmt: v => dkRate(v), height: 150 });

  // Prozesse (nach CPU, dann Speicher)
  const procs = [...(pc?.procs || [])].sort((a, b) => b.cpuPct - a.cpuPct || b.memB - a.memB).slice(0, 8);
  const maxMem = Math.max(1, ...procs.map(p => p.memB));
  R.procs.replaceChildren(...(procs.length ? [el("div", { class: "dk-proc dk-proc-h muted" }, el("span", {}, "Programm"), el("span", {}, "CPU"), el("span", {}, "Speicher")),
    ...procs.map(p => el("div", { class: "dk-proc" },
      el("span", { class: "dk-proc-n", title: p.name }, p.name),
      el("span", { class: "dk-proc-v" }, el("i", { style: `width:${Math.min(100, p.cpuPct)}%;background:var(--s1)` }), el("b", {}, dkPct(p.cpuPct))),
      el("span", { class: "dk-proc-v" }, el("i", { style: `width:${p.memB / maxMem * 100}%;background:var(--s2)` }), el("b", {}, dkBytes(p.memB)))))]
    : [el("div", { class: "muted" }, pc ? "Die Prozessliste gibt es nur unter Windows." : "Keine Angaben")]));

  // Hardware
  const hw = [];
  const row = (label, main, sub) => main && hw.push(el("div", { class: "dk-hw-row" }, el("div", { class: "dk-hw-l" }, label), el("div", {}, el("div", { class: "dk-hw-main" }, main), sub ? el("div", { class: "dk-hw-sub" }, sub) : null)));
  if (info) {
    row("Prozessor", info.cpu, [info.cores && `${info.cores} Kerne`, info.threads && `${info.threads} Threads`, info.cpuMaxMHz && `${dkNum(info.cpuMaxMHz / 1000, 2)} GHz`].filter(Boolean).join(" · "));
    for (const x of info.gpus || []) row("Grafikkarte", x.name, [x.vramB && dkBytes(x.vramB, 0), x.display, x.driver && `Treiber ${x.driver}`].filter(Boolean).join(" · "));
    row("Arbeitsspeicher", info.ramTotalB ? dkBytes(info.ramTotalB, 0) : null,
      (info.ramModules || []).map(m => [m.slot, dkBytes(m.sizeB, 0), m.speedMHz && `${m.speedMHz} MT/s`, m.maker, m.part].filter(Boolean).join(" ")).join("\n"));
    row("Mainboard", info.board, info.bios && `BIOS ${info.bios}`);
    for (const x of info.disks || []) row("Datenträger", x.name, [dkBytes(x.sizeB, 0), x.type, x.bus].filter(Boolean).join(" · "));
    for (const x of info.nics || []) row("Netzwerk", x.name, x.speed);
    row("System", info.system, null);
    row("Betriebssystem", info.os, null);
  }
  R.hw.replaceChildren(...(hw.length ? hw : [el("div", { class: "muted" }, "Hardware wird ermittelt …")]));
}

// ---------------------------------------------------------------- 3D-Modell
async function dkModel(d) {
  const R = DK.refs;
  const color = d.config?.modelColor === "auto" || !d.config?.modelColor ? (d.file?.filamentColor || "#ff7a00") : d.config.modelColor;
  if (!d.model.has_file) {
    R.modelMsg.hidden = false; R.modelMsg.textContent = "Kein Modell"; R.modelInfo.textContent = "";
    DK.viewer?.clear(); DK.viewerRev = d.model.rev; return;
  }
  try {
    if (!DK.viewer) {
      if (DK.viewerLoading) return;
      DK.viewerLoading = true;
      const { ModelViewer } = await import("/druck/viewer.js");
      DK.viewer = new ModelViewer(R.modelCanvas, { color, speed: 0.35, width: 720, height: 540 });
      DK.viewer.setPixelScale(1);
      DK.viewerLoading = false;
    }
    DK.viewer.paused = !DK.visible;
    DK.viewer.setColor(color);
    const live = d.live || {};
    DK.viewer.setProgress(d.online && ["printing", "paused"].includes(live.state) && live.progress >= 0 ? live.progress : null);
    if (DK.viewerRev !== d.model.rev) {
      DK.viewerRev = d.model.rev;
      R.modelMsg.hidden = false; R.modelMsg.textContent = "Lade Modell …";
      const info = await DK.viewer.load("/druck/api/model");
      R.modelMsg.hidden = !!info;
      if (!info) R.modelMsg.textContent = "Kein Modell";
      R.modelInfo.textContent = info ? `${info.name}` + (info.size ? ` · ${info.size.map(v => dkNum(v, 1)).join(" × ")} mm` : "") : "";
    }
  } catch (e) {
    DK.viewerLoading = false;
    R.modelMsg.hidden = false; R.modelMsg.textContent = "3D-Ansicht nicht möglich: " + e.message;
  }
}

// ---------------------------------------------------------------- Kamera (Einzelbilder vom Server)
async function dkCamLoop(run) {
  const R = DK.refs, ctx = R.cam.getContext("2d");
  let lastFrame = 0;
  while (DK.camRun === run) {
    try {
      const r = await fetch(`/druck/api/frame?after=${DK.camSeq}`, { cache: "no-store", credentials: "same-origin" });
      if (DK.camRun !== run) break;
      if (r.status === 200) {
        DK.camSeq = +r.headers.get("X-Seq");
        const bmp = await createImageBitmap(await r.blob());
        if (R.cam.width !== bmp.width || R.cam.height !== bmp.height) { R.cam.width = bmp.width; R.cam.height = bmp.height; }
        ctx.drawImage(bmp, 0, 0); bmp.close();
        lastFrame = Date.now();
      } else if (r.status === 401) { await new Promise(res => setTimeout(res, 5000)); }
    } catch (e) { await new Promise(res => setTimeout(res, 1000)); }
    const fresh = Date.now() - lastFrame < 5000;
    const cam = DK.data?.camera;
    R.camMsg.hidden = !!lastFrame;
    if (!lastFrame) R.camMsg.textContent = DK.data && !DK.data.online ? "Druckmonitor-App offline" : cam?.error || "Warte auf Kamerabild …";
    R.camBadge.textContent = fresh ? `LIVE${cam?.fps >= 1 ? " · " + dkNum(cam.fps) + " fps" : ""}` : lastFrame ? `Bild von ${new Date(lastFrame).toLocaleTimeString("de-DE")}` : "";
    R.camBadge.classList.toggle("stale", !fresh);
  }
}

// ---------------------------------------------------------------- Laden
async function dkLoad() {
  if (DK.busy) return;
  DK.busy = true;
  try {
    const d = await api(`/api/admin/druck/live?since=${DK.lastT}`);
    if (d.history.length) {
      DK.hist.push(...d.history);
      if (DK.hist.length > DK_HIST_MAX) DK.hist.splice(0, DK.hist.length - DK_HIST_MAX);
      DK.lastT = DK.hist[DK.hist.length - 1].t;
    }
    if (!DK.built) dkBuild();
    dkUpdate(d);
    dkLoadJobs();
  } catch (e) {
    if (DK.built) dkSetLive(false, "Server nicht erreichbar");
  } finally { DK.busy = false; }
}

// Aufruf beim Reiterwechsel
function showDruck(on) {
  DK.visible = on;
  clearInterval(DK.timer); DK.timer = null;
  DK.camRun++;
  if (DK.viewer) DK.viewer.paused = !on;
  if (!on) return;
  dkLoad().then(() => { if (DK.visible) dkCamLoop(DK.camRun); });
  DK.timer = setInterval(() => { if (!document.hidden) dkLoad(); }, 2000);
}
let dkResizeT;
addEventListener("resize", () => { clearTimeout(dkResizeT); dkResizeT = setTimeout(() => { if (DK.visible && DK.data) dkUpdate(DK.data); }, 200); });

// ---------------------------------------------------------------- Drucken (Aufträge)
// Datei hochladen → Server slict für den Adventurer 5M → "Drucken" → Druckmonitor-App schickt sie an den Drucker.
const DKJ = { opts: { material: "PLA", quality: "standard", infill: 15, supports: false, brim: true }, last: "", data: null, busy: false };
const DKJ_STATE = {
  slicing: ["Wird geslict …", "warm"], ready: ["Bereit", "ok"], failed: ["Slicen fehlgeschlagen", "bad"],
  queued: ["Wartet auf Druckmonitor …", "warm"], sending: ["Wird übertragen …", "run"], printing: ["An den Drucker geschickt", "ok"],
  error: ["Fehler", "bad"],
};
const DKJ_QUALITY = { fein: "Fein · 0,12 mm", standard: "Standard · 0,20 mm", schnell: "Schnell · 0,28 mm" };

function dkOptionsForm(o) {
  const mat = el("select", {}, ...["PLA", "PETG", "ABS", "ASA", "TPU"].map(m => el("option", { value: m, selected: o.material === m }, m)));
  const q = el("select", {}, ...Object.entries(DKJ_QUALITY).map(([k, v]) => el("option", { value: k, selected: o.quality === k }, v)));
  const infillVal = el("b", {}, `${o.infill} %`);
  const infill = el("input", { type: "range", min: 0, max: 100, step: 5, value: o.infill, oninput: () => infillVal.textContent = `${infill.value} %` });
  const sup = el("input", { type: "checkbox", checked: o.supports });
  const brim = el("input", { type: "checkbox", checked: o.brim });
  const warn = el("div", { class: "dkj-warn" });
  const upd = () => warn.textContent = ["ABS", "ASA"].includes(mat.value) ? "ABS/ASA nur mit geschlossenem Gehäuse (Adventurer 5M Pro) drucken." : mat.value === "TPU" ? "TPU wird sehr langsam gedruckt." : "";
  mat.addEventListener("change", upd); upd();
  const node = el("div", { class: "dkj-form" },
    el("label", {}, "Material", mat), el("label", {}, "Qualität", q),
    el("label", {}, el("span", {}, "Füllung ", infillVal), infill),
    el("label", { class: "dkj-check" }, sup, "Stützstrukturen (automatisch)"),
    el("label", { class: "dkj-check" }, brim, "Rand (Brim) für bessere Haftung"), warn);
  return { node, value: () => ({ material: mat.value, quality: q.value, infill: +infill.value, supports: sup.checked, brim: brim.checked }) };
}

function dkJobsCard() {
  const R = DK.refs;
  const input = el("input", { type: "file", accept: ".stl,.3mf,.obj,.gcode,.gco,.g,.gx", hidden: true, onchange: () => { const f = input.files[0]; input.value = ""; if (f) dkUploadJob(f); } });
  R.jobForm = dkOptionsForm(DKJ.opts);
  R.jobDrop = el("div", { class: "drop dkj-drop", onclick: () => input.click() },
    el("strong", {}, "3D-Datei hierher ziehen"), el("span", {}, "oder klicken · STL, 3MF, OBJ werden automatisch für den Adventurer 5M geslict · fertiger G-Code geht direkt"), input);
  R.jobDrop.addEventListener("dragover", e => { e.preventDefault(); R.jobDrop.classList.add("over"); });
  R.jobDrop.addEventListener("dragleave", () => R.jobDrop.classList.remove("over"));
  R.jobDrop.addEventListener("drop", e => { e.preventDefault(); R.jobDrop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) dkUploadJob(f); });
  R.jobProgress = el("div", { class: "progress", hidden: true }, el("div"));
  R.jobPrinter = el("div", { class: "dkj-printer muted" });
  R.jobList = el("div", { class: "dkj-list" });
  return dkCard("span-12", "Drucken",
    el("div", { class: "dkj-top" }, el("div", {}, R.jobDrop, R.jobProgress), R.jobForm.node),
    R.jobPrinter, R.jobList);
}

async function dkUploadJob(f) {
  const R = DK.refs, bar = R.jobProgress.firstChild;
  DKJ.opts = R.jobForm.value();
  R.jobProgress.hidden = false; bar.style.width = "0%";
  try {
    const { id } = await api("/api/admin/uploads", json("POST", { filename: f.name, size: f.size, kind: "druckjob", options: DKJ.opts }));
    let off = 0;
    while (off < f.size) {
      const r = await api(`/api/admin/uploads/${id}?offset=${off}`, { method: "PUT", body: f.slice(off, off + CHUNK), headers: { "Content-Type": "application/octet-stream" } });
      off = r.received; bar.style.width = Math.round(off / f.size * 100) + "%";
    }
    const job = await api(`/api/admin/uploads/${id}/complete`, json("POST", {}));
    toast(job.state === "slicing" ? `„${job.name}“ wird geslict …` : `„${job.name}“ ist bereit`);
  } catch (err) { toast("Fehler: " + err.message); }
  R.jobProgress.hidden = true;
  DKJ.last = ""; dkLoadJobs();
}

async function dkLoadJobs() {
  if (DKJ.busy) return;
  DKJ.busy = true;
  try {
    const d = await api("/api/admin/druck/jobs");
    const key = JSON.stringify(d);
    if (key !== DKJ.last) { DKJ.last = key; DKJ.data = d; dkRenderJobs(d); }
  } catch (e) { /* nächster Versuch beim nächsten Laden */ } finally { DKJ.busy = false; }
}

function dkPrinterReady(p) {
  if (!p.app_online) return [false, "Die Druckmonitor-App ist nicht verbunden – drucken geht erst, wenn sie läuft."];
  if (!p.can_upload) return [false, "In der Druckmonitor-App fehlen Seriennummer und Prüfcode (oder die App ist veraltet) – ohne sie kann sie nichts an den Drucker schicken."];
  if (!p.online) return [false, "Der Drucker ist nicht erreichbar."];
  if (!["idle", "done"].includes(p.state)) return [false, `Der Drucker ist gerade beschäftigt (${p.status || p.state}).`];
  return [true, "Drucker bereit."];
}

function dkRenderJobs(d) {
  const R = DK.refs;
  const [ready, why] = dkPrinterReady(d.printer || {});
  R.jobPrinter.replaceChildren(el("span", { class: "dot" + (ready ? " on" : "") }), why);
  if (!d.jobs.length) { R.jobList.replaceChildren(el("div", { class: "muted dkj-empty" }, "Noch keine Druckaufträge.")); return; }
  R.jobList.replaceChildren(...d.jobs.map(j => {
    const [label, cls] = DKJ_STATE[j.state] || [j.state, "idle"];
    const st = j.stats || {};
    const o = j.options || {};
    const facts = [
      st.time_s ? `⏱ ${dkDur(st.time_s)}` : null,
      st.filament_g ? `${dkNum(st.filament_g, 0)} g Filament` : st.filament_m ? `${dkNum(st.filament_m, 1)} m Filament` : null,
      st.layers ? `${dkNum(st.layers)} Schichten` : null,
      j.sliced_by_user ? "eigener G-Code" : `${o.material} · ${DKJ_QUALITY[o.quality] || o.quality} · ${o.infill} % Füllung${o.supports ? " · Stützen" : ""}`,
    ].filter(Boolean);
    const canPrint = ready && ["ready", "error", "printing"].includes(j.state);
    return el("div", { class: "dkj-job" },
      el("div", { class: "dkj-main" },
        el("div", { class: "dkj-name" }, j.name),
        el("div", { class: "dkj-facts" }, ...facts.map(f => el("span", {}, f))),
        j.message ? el("div", { class: "dkj-msg " + (["failed", "error"].includes(j.state) ? "bad" : "") }, j.message) : null),
      el("span", { class: `dk-state ${cls}` }, el("i"), el("span", {}, label)),
      el("div", { class: "dkj-actions" },
        el("button", { class: "btn small", onclick: () => dkPreviewJob(j) }, "Vorschau"),
        !j.sliced_by_user && !["slicing", "queued", "sending"].includes(j.state)
          ? el("button", { class: "btn small", onclick: () => dkResliceJob(j) }, "Einstellungen") : null,
        j.state === "queued" ? el("button", { class: "btn small", onclick: async () => { await api(`/api/admin/druck/jobs/${j.id}/cancel`, { method: "POST" }); DKJ.last = ""; dkLoadJobs(); } }, "Zurückholen") : null,
        el("button", { class: "btn small primary", disabled: !canPrint, title: canPrint ? "" : why, onclick: () => dkPrintJob(j) }, "Drucken"),
        !["slicing", "queued", "sending"].includes(j.state)
          ? el("button", { class: "btn small danger", onclick: async () => { if (await confirmDlg("Auftrag löschen?", `„${j.name}“ wird vom Server gelöscht.`)) { await api(`/api/admin/druck/jobs/${j.id}`, { method: "DELETE" }); DKJ.last = ""; dkLoadJobs(); } } }, "Löschen") : null));
  }));
}

async function dkPrintJob(j) {
  const mat = j.sliced_by_user ? "das passende Filament" : `${j.options.material}-Filament`;
  const c1 = el("input", { type: "checkbox" }), c2 = el("input", { type: "checkbox" }), lev = el("input", { type: "checkbox", checked: true });
  const content = [
    el("p", {}, `„${j.name}“ wird an den Drucker geschickt und startet sofort` + (j.stats?.time_s ? ` (ca. ${dkDur(j.stats.time_s)}).` : ".")),
    el("label", { class: "dkj-check" }, c1, "Das Druckbett ist leer und sauber"),
    el("label", { class: "dkj-check" }, c2, `${mat[0].toUpperCase() + mat.slice(1)} ist eingelegt`),
    el("label", { class: "dkj-check" }, lev, "Vor dem Druck das Bett vermessen (empfohlen)"),
  ];
  if (await dialog("Jetzt drucken?", content, [["Abbrechen", ""], ["Drucken", "ok", "primary"]]) !== "ok") return;
  if (!c1.checked || !c2.checked) { toast("Bitte erst Druckbett und Filament prüfen und beides abhaken"); return; }
  try {
    await api(`/api/admin/druck/jobs/${j.id}/print`, json("POST", { leveling: lev.checked }));
    toast("Wird an die Druckmonitor-App übergeben …");
  } catch (err) { toast(err.message); }
  DKJ.last = ""; dkLoadJobs();
}

async function dkResliceJob(j) {
  const form = dkOptionsForm(j.options);
  if (await dialog(`„${j.name}“ neu slicen`, [form.node], [["Abbrechen", ""], ["Neu slicen", "ok", "primary"]]) !== "ok") return;
  try { await api(`/api/admin/druck/jobs/${j.id}/slice`, json("POST", form.value())); } catch (err) { toast(err.message); }
  DKJ.last = ""; dkLoadJobs();
}

let dkPreviewViewer = null;
async function dkPreviewJob(j) {
  const canvas = el("canvas", { class: "dk-3d" });
  const msg = el("div", { class: "dk-cam-msg" }, "Lade Vorschau …");
  const kind = j.gcode ? "gcode" : "source";
  const box = el("div", { class: "dk-3d-box dkj-preview" }, canvas, msg);
  const info = el("p", { class: "muted", style: "font-size:13px;margin:8px 0 0" }, kind === "gcode" ? "Vorschau des geslicten G-Codes (Druckwege)" : "Vorschau des Modells");
  const p = dialog(j.name, [box, info], [["Schließen", ""]]);
  $("#dlg").classList.add("wide");
  try {
    const { ModelViewer } = await import("/druck/viewer.js");
    dkPreviewViewer = new ModelViewer(canvas, { color: "#ff7a00", speed: 0.35, width: 800, height: 600 });
    dkPreviewViewer.setPixelScale(1);
    const r = await dkPreviewViewer.load(`/api/admin/druck/jobs/${j.id}/preview/${kind}`);
    msg.hidden = !!r;
    if (r?.size) info.textContent += ` · ${r.size.map(v => dkNum(v, 1)).join(" × ")} mm`;
  } catch (e) { msg.textContent = "Vorschau nicht möglich: " + e.message; }
  await p;
  $("#dlg").classList.remove("wide");
  if (dkPreviewViewer) { dkPreviewViewer.paused = true; dkPreviewViewer.clear(); dkPreviewViewer.renderer?.dispose(); dkPreviewViewer = null; }
}
