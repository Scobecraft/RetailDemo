"use strict";
// Präsentation: Marken-Intro -> animierte Spec-Seite -> Videos/Bilder der Playlist -> von vorn.
// Nach jedem n-ten Medium (specs_every_n) kommen Intro und Spec-Seite erneut.

const stage = document.getElementById("stage");
const progress = document.getElementById("progress");
let vm = null;
let runId = 0;

const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const wait = (ms, id) => new Promise(r => setTimeout(() => r(id === runId), ms));

// ---------------------------------------------------------------- Ablauf
function buildSequence(v) {
  const seq = [];
  const hasBrand = !!(v.logo || v.store_name);
  const intro = () => {
    if (hasBrand) seq.push({ kind: "brand" });
    if (v.show_specs) seq.push({ kind: "specs" });
  };
  intro();
  const n = Math.max(1, v.specs_every_n || 3);
  v.items.forEach((item, i) => {
    seq.push({ kind: "media", item });
    if ((i + 1) % n === 0 && i < v.items.length - 1) intro();
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

async function play(scene, id) {
  if (scene.kind === "brand") {
    show(brandScene());
    runProgress(4500);
    return wait(4500, id);
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
  return h(`<section class="scene brand"><div class="wrap">${logo}${name}<div class="welcome">Willkommen</div></div></section>`);
}

function specsScene() {
  const specs = (vm.specs || []).filter(s => s.value);
  const price = specs.find(s => isPrice(s.label));
  const rest = specs.filter(s => s !== price).slice(0, 8);
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
        <div class="underline"></div>
        ${price ? `<div class="price"><small>${escapeHtml(price.label || "Preis")}</small><strong>${escapeHtml(price.value)}</strong></div>` : ""}
      </div>
      <div class="cards ${rest.length <= 3 ? "one" : ""}">${cards}</div>
    </section>`);
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
  if (item.type === "image") {
    const ms = (item.duration_s || 8) * 1000;
    const node = h(`<section class="scene media" style="--dur:${ms + 1500}ms"><img class="full" src="${escapeHtml(item.src)}" alt="">${mediaBadge()}</section>`);
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
  const id = ++runId;
  stage.replaceChildren();
  if (vm) run(id);
}

function stop() {
  runId++;
  stage.querySelectorAll("video").forEach(v => v.pause());
  stage.replaceChildren();
}

rd.on("demo:start", start);
rd.on("demo:stop", stop);
rd.on("vm", v => { vm = v; }); // greift ab dem nächsten Durchlauf

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
