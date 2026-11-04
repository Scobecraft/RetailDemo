"use strict";
// Präsentation: Marken-Intro -> animierte Spec-Seite -> Videos/Bilder der Playlist -> von vorn.
// Nach jedem n-ten Medium (specs_every_n) kommen Intro und Spec-Seite erneut.

const stage = document.getElementById("stage");
const progress = document.getElementById("progress");
let vm = null;
let runId = 0;

const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const wait = (ms, id) => new Promise(r => setTimeout(() => r(id === runId), ms));

// ---------------------------------------------------------------- Themes
// Farben: demo.css (body[data-theme]); Partikel, Lichterkette und Eröffnungs-Szene: themes.js
const themeInfo = v => Theme.info(v);

function applyTheme(v) {
  Theme.apply(v);
  const t = themeInfo(v);
  const ribbon = document.getElementById("ribbon");
  ribbon.hidden = !t;
  ribbon.firstElementChild.textContent = t ? t.ribbon : "";
  ribbon.classList.toggle("long", !!t && t.ribbon.length > 12);
}

// ---------------------------------------------------------------- Ablauf
let lastMediaId = null;

/** Zufällige Reihenfolge (Fisher-Yates); das zuletzt gezeigte Medium kommt nicht direkt wieder. */
function shuffled(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  if (a.length > 1 && a[0].id === lastMediaId) [a[0], a[a.length - 1]] = [a[a.length - 1], a[0]];
  return a;
}

function buildSequence(v) {
  const seq = [];
  const hasBrand = !!(v.logo || v.store_name);
  let first = true;
  const intro = () => {
    // Theme-Szene (Black Week, Weihnachten …) eröffnet jede Runde
    if (first && Theme.hasScene()) seq.push({ kind: "theme" });
    first = false;
    if (hasBrand) seq.push({ kind: "brand" });
    if (v.show_specs) seq.push({ kind: "specs" });
    if (v.show_specs && v.suitability) seq.push({ kind: "fit" });
  };
  intro();
  const n = Math.max(1, v.specs_every_n || 3);
  const items = v.shuffle ? shuffled(v.items) : v.items;
  items.forEach((item, i) => {
    seq.push({ kind: "media", item });
    if ((i + 1) % n === 0 && i < items.length - 1) intro();
  });
  if (!seq.length) seq.push({ kind: "specs" });
  return seq;
}

async function run(id) {
  while (id === runId) {
    const seq = buildSequence(vm);
    for (const scene of seq) {
      if (id !== runId) return;
      await play(scene, id);
    }
  }
}

function show(node) {
  const old = [...stage.children];
  stage.append(node);
  // Doppel-rAF: erst einfügen, dann Übergang starten
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("in")));
  for (const o of old) {
    o.classList.remove("in");
    setTimeout(() => { o.querySelectorAll("video").forEach(v => v.pause()); o.remove(); }, 1000);
  }
}

function runProgress(ms) {
  progress.style.transition = "none";
  progress.style.width = "0";
  requestAnimationFrame(() => requestAnimationFrame(() => {
    progress.style.transition = `width ${ms}ms linear`;
    progress.style.width = "100%";
  }));
}

const aiNote = document.getElementById("aiNote");
/** KI-Hinweis nur bei erzeugten Szenen, nicht bei eigenen Videos/Bildern */
function setAiNote(visible) {
  aiNote.hidden = false;
  aiNote.classList.toggle("on", visible);
}

async function play(scene, id) {
  Theme.onScene(scene.kind);
  setAiNote(scene.kind !== "media");
  if (scene.kind === "theme") {
    show(h(Theme.scene(vm)));
    runProgress(6500);
    return wait(6500, id);
  }
  if (scene.kind === "brand") {
    show(brandScene());
    runProgress(4500);
    return wait(4500, id);
  }
  if (scene.kind === "fit") {
    show(fitScene());
    runProgress(9000);
    return wait(9000, id);
  }
  if (scene.kind === "specs") {
    const ms = vm.specs_duration_s * 1000;
    show(specsScene());
    runProgress(ms);
    return wait(ms, id);
  }
  return playMedia(scene.item, id);
}

// ---------------------------------------------------------------- Szenen
function brandScene() {
  const logo = vm.logo ? `<div class="ring"></div><div class="ring r2"></div><img class="logo" src="${escapeHtml(vm.logo)}" alt="">` : "";
  const name = vm.store_name ? `<div class="store ${vm.logo ? "" : "big"}">${escapeHtml(vm.store_name)}</div>` : "";
  // Offline-Version: "Willkommen bei" über dem Ladennamen
  if (vm.welcome_prefix && vm.store_name) {
    const claim = themeInfo(vm) ? `<div class="claim">${escapeHtml(themeInfo(vm).claim)}</div>` : "";
    return h(`<section class="scene brand prefix"><div class="wrap">${logo}<div class="welcome">Willkommen bei</div>${name}${claim}</div></section>`);
  }
  const claim = themeInfo(vm) ? `<div class="claim">${escapeHtml(themeInfo(vm).claim)}</div>` : "";
  return h(`<section class="scene brand"><div class="wrap">${logo}${name}<div class="welcome">Willkommen</div>${claim}</div></section>`);
}

function specsScene() {
  const specs = (vm.specs || []).filter(s => s.value);
  const oldPrice = specs.find(s => isOldPrice(s.label));
  const price = specs.find(s => isPrice(s.label) && s !== oldPrice);
  const rest = specs.filter(s => s !== price && s !== oldPrice).slice(0, 8);
  const name = vm.display_name || "Dieser Laptop";
  const words = name.split(/\s+/).map((w, i) => `<span class="w"><span style="animation-delay:${0.35 + i * 0.09}s">${escapeHtml(w)}</span></span>`).join("");
  const cards = rest.map((s, i) => `
    <div class="card" style="animation-delay:${0.7 + i * 0.12}s, ${1.6 + i * 0.12}s">
      <div class="ic">${specIcon(s.label)}</div>
      <div class="tx"><div class="lb">${escapeHtml(s.label || "Ausstattung")}</div><div class="vl">${escapeHtml(s.value)}</div></div>
    </div>`).join("");
  const top = vm.logo ? `<img src="${escapeHtml(vm.logo)}" alt="">` : vm.store_name ? `<div class="storename">${escapeHtml(vm.store_name)}</div>` : "";
  return h(`
    <section class="scene specs">
      <div class="top">${top}</div>
      <div>
        ${vm.manufacturer ? `<div class="eyebrow">${escapeHtml(vm.manufacturer)}</div>` : ""}
        <h1>${words}</h1>
        ${idealChip()}
        <div class="underline"></div>
        ${price ? `<div class="price"><small>${escapeHtml(price.label || "Preis")}</small>${oldPrice ? `<s class="old">statt ${escapeHtml(oldPrice.value)}</s>` : ""}<strong>${escapeHtml(price.value)}</strong></div>` : ""}
      </div>
      <div class="cards ${rest.length <= 3 ? "one" : ""}">${cards}</div>
    </section>`);
}

/** "★ Ideal für Gaming" unter dem Gerätenamen */
function idealChip() {
  const f = vm.suitability;
  const best = f && f.items.find(i => i.key === f.best);
  return best ? `<div class="ideal"><span class="ic">${fitIcon(best.key)}</span>Ideal für ${escapeHtml(best.label)}</div>` : "";
}

/** "Wofür eignet sich dieser Laptop?" – vier Kacheln mit Balken, die beste hervorgehoben */
function fitScene() {
  const f = vm.suitability;
  const top = vm.logo ? `<img src="${escapeHtml(vm.logo)}" alt="">` : vm.store_name ? `<div class="storename">${escapeHtml(vm.store_name)}</div>` : "";
  const tiles = f.items.map((it, i) => {
    const delay = 0.6 + i * 0.18;
    const segs = Array.from({ length: 5 }, (_, j) =>
      `<i class="${j < it.stars ? "on" : ""}" style="animation-delay:${(delay + 0.5 + j * 0.13).toFixed(2)}s"></i>`).join("");
    return `<div class="fit-tile ${it.key === f.best ? "best" : ""} s${it.stars}" style="animation-delay:${delay.toFixed(2)}s">
      ${it.key === f.best ? `<div class="crown">★ Ideal</div>` : ""}
      <div class="fit-ic">${fitIcon(it.key)}</div>
      <div class="fit-name">${escapeHtml(it.label)}</div>
      <div class="fit-sub">${escapeHtml(it.sub)}</div>
      <div class="meter">${segs}</div>
      <div class="verdict" style="animation-delay:${(delay + 1.3).toFixed(2)}s">${escapeHtml(it.verdict)}</div>
    </div>`;
  }).join("");
  return h(`<section class="scene fit">
    <div class="top">${top}</div>
    <div class="fit-head"><div class="eyebrow">${escapeHtml(vm.display_name || "Dieser Laptop")}</div><h2>Wofür eignet sich dieser Laptop?</h2></div>
    <div class="fit-grid">${tiles}</div></section>`);
}

function mediaBadge() {
  const parts = [];
  if (vm.logo) parts.push(`<img src="${escapeHtml(vm.logo)}" alt="">`);
  else if (vm.store_name) parts.push(`<span class="dn">${escapeHtml(vm.store_name)}</span>`);
  if (vm.display_name) {
    if (parts.length) parts.push(`<span class="sep"></span>`);
    parts.push(`<span class="dn">${escapeHtml(vm.display_name)}</span>`);
  }
  return parts.length ? `<div class="badge">${parts.join("")}</div>` : "";
}

function playMedia(item, id) {
  lastMediaId = item.id;
  if (item.type === "image") {
    const ms = (item.duration_s || 8) * 1000;
    const node = h(`<section class="scene media" style="--dur:${ms + 1500}ms"><img class="fill" src="${escapeHtml(item.src)}" alt=""><img class="full" src="${escapeHtml(item.src)}" alt="">${mediaBadge()}</section>`);
    show(node);
    runProgress(ms);
    return wait(ms, id);
  }
  return new Promise(resolve => {
    const node = h(`<section class="scene media"><video muted playsinline preload="auto"></video>${mediaBadge()}</section>`);
    const video = node.querySelector("video");
    let done = false;
    const finish = (delay = 0) => {
      if (done) return;
      done = true;
      clearInterval(watch);
      setTimeout(() => resolve(id === runId), delay);
    };
    // Abbruch (Kunde kommt) oder Wiedergabe hängt
    const watch = setInterval(() => { if (id !== runId) finish(); }, 250);
    video.addEventListener("ended", () => finish());
    video.addEventListener("error", () => finish(300)); // Format nicht unterstützt -> überspringen
    video.addEventListener("loadedmetadata", () => {
      runProgress((video.duration || 30) * 1000);
      setTimeout(() => finish(), Math.min((video.duration || 600) * 1000 + 3000, 15 * 60_000));
    });
    video.src = item.src;
    show(node);
    video.play().catch(() => finish(300));
  });
}

// ---------------------------------------------------------------- Steuerung
function start(v) {
  vm = v || vm;
  applyTheme(vm);
  Theme.resume();
  const id = ++runId;
  stage.replaceChildren();
  if (vm) run(id);
}

function stop() {
  runId++;
  setAiNote(false);
  Theme.pause();
  stage.querySelectorAll("video").forEach(v => v.pause());
  stage.replaceChildren();
}

rd.on("demo:start", start);
rd.on("demo:stop", stop);
rd.on("vm", v => { vm = v; applyTheme(v); }); // Inhalte greifen ab dem nächsten Durchlauf

// Jede Eingabe beendet die Demo (der Hauptprozess entscheidet)
let moved = 0, lastX = null, lastY = null;
window.addEventListener("mousemove", e => {
  if (lastX !== null) moved += Math.abs(e.screenX - lastX) + Math.abs(e.screenY - lastY);
  lastX = e.screenX; lastY = e.screenY;
  if (moved > 8) { moved = 0; rd.send("demo:input"); }
});
for (const ev of ["mousedown", "keydown", "wheel", "touchstart", "pointerdown"]) {
  window.addEventListener(ev, e => { e.preventDefault(); rd.send("demo:input"); }, { passive: false });
}

// Vorschau ohne Hauptprozess (z. B. beim Entwickeln): ?preview
if (location.search.includes("preview")) rd.invoke("vm").then(start);
