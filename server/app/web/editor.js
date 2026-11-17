// Reiter "Video-Schnitt": kleines Schnittprogramm für Werbevideos (Hoch-, Quer- und Quadratformat).
// Links Bibliothek (Medien, Musik, Texte), Mitte Vorschau, rechts Eigenschaften, unten Zeitleiste mit
// Video-, Text- und Tonspur. Gerendert wird auf dem Server (editor.py) – das Ergebnis landet in den Medien.
// Nutzt $, el, api, json, toast, dialog, confirmDlg, CHUNK, thumbUrl, state, loadAll, size (index.html).
"use strict";

const ED = {
  built: false, visible: false, projects: [], p: null, info: {}, audio: [], sel: null, t: 0, playing: false,
  pxs: 60, undo: [], redo: [], saveTimer: null, saved: true, els: {}, raf: 0, renderTimer: null, libTab: "media",
};
const ED_FORMATS = { portrait: [1080, 1920, "Hochformat 9:16"], landscape: [1920, 1080, "Querformat 16:9"], square: [1080, 1080, "Quadrat 1:1"] };
const ED_FONTS = { "sans-bold": ["bold", "DejaVu Sans, Verdana, Arial, sans-serif", "Sans fett"], "sans": ["normal", "DejaVu Sans, Verdana, Arial, sans-serif", "Sans"],
  "serif-bold": ["bold", "DejaVu Serif, Georgia, serif", "Serif fett"], "mono": ["bold", "DejaVu Sans Mono, Consolas, monospace", "Mono fett"] };
const ED_TRANS = { none: "Harter Schnitt", fade: "Überblenden", fadeblack: "Über Schwarz", slideleft: "Schieben", wipeleft: "Wischen", circleopen: "Kreis" };
const ED_TEXT_PRESETS = [
  ["Überschrift", { text: "Jetzt neu!", size: 9, y: 0.15, bg_on: false, anim: "slide" }],
  ["Preis", { text: "Nur 499 €", size: 11, y: 0.5, bg_on: true, bg: "#ee7f00", bg_alpha: 0.95, anim: "fade" }],
  ["Untertitel", { text: "Text hier eingeben", size: 4.5, y: 0.85, bg_on: true, bg: "#000000", bg_alpha: 0.6, anim: "fade" }],
  ["Hinweis", { text: "Solange der Vorrat reicht", size: 3, y: 0.93, bg_on: false, anim: "fade" }],
];
const edId = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
const edFmtT = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
const edDur = c => c.out - c.in;

// Start jedes Clips und Gesamtlänge – wie timeline() auf dem Server (Überblendungen überlappen)
function edTimeline(p = ED.p) {
  const starts = []; let t = 0;
  p.clips.forEach((c, i) => {
    const d = edDur(c);
    const tr = i && c.transition !== "none" ? Math.min(c.transition_s, d / 2, edDur(p.clips[i - 1]) / 2) : 0;
    t -= tr; starts.push(t); t += d;
  });
  return { starts, total: Math.max(0, t) };
}

// ---------------------------------------------------------------- Laden / Speichern
async function edMediaInfo(id) {
  if (!ED.info[id]) ED.info[id] = await api(`/api/admin/editor/media/${id}`);
  return ED.info[id];
}

async function edLoadProjects() {
  ED.projects = await api("/api/admin/editor/projects");
  ED.audio = await api("/api/admin/editor/audio");
}

async function edOpen(id) {
  edStop();
  const p = await api(`/api/admin/editor/projects/${id}`);
  for (const c of p.clips) await edMediaInfo(c.media_id).catch(() => {});
  ED.p = p; ED.sel = null; ED.t = 0; ED.undo = []; ED.redo = []; ED.saved = true;
  try { localStorage.setItem("edProject", id); } catch (e) {}
  edRenderAll();
  if (p.render?.state === "rendering") edPollRender();
}

async function edNew(format) {
  const p = await api("/api/admin/editor/projects", json("POST", { project: { name: `Werbung ${new Date().toLocaleDateString("de-DE")}`, format } }));
  await edLoadProjects();
  await edOpen(p.id);
}

// Jede Änderung: Rückgängig-Schritt merken, neu zeichnen, verzögert speichern
function edChange(fn, { redraw = true } = {}) {
  ED.undo.push(JSON.stringify(ED.p)); if (ED.undo.length > 60) ED.undo.shift();
  ED.redo = [];
  fn(ED.p);
  edDirty();
  if (redraw) edRenderAll(); else { edRenderTimeline(); edDraw(); }
}
function edDirty() {
  ED.saved = false; edSaveState();
  clearTimeout(ED.saveTimer);
  ED.saveTimer = setTimeout(edSave, 800);
}
async function edSave() {
  if (!ED.p) return;
  const { render, ...project } = ED.p;
  try {
    const p = await api(`/api/admin/editor/projects/${ED.p.id}`, json("PUT", { project }));
    ED.saved = true; ED.p.updated = p.updated;
  } catch (err) { toast("Speichern fehlgeschlagen: " + err.message); }
  edSaveState();
}
function edSaveState() { if (ED.els.saved) ED.els.saved.textContent = ED.saved ? "✓ gespeichert" : "speichert …"; }
function edUndo(back = true) {
  const from = back ? ED.undo : ED.redo, to = back ? ED.redo : ED.undo;
  if (!from.length) return;
  to.push(JSON.stringify(ED.p));
  const keep = ED.p.render;
  ED.p = { ...JSON.parse(from.pop()), render: keep };
  if (ED.sel && !edSelObj()) ED.sel = null;
  edDirty(); edRenderAll();
}

// ---------------------------------------------------------------- Aufbau
function edBuild() {
  const page = $("[data-page=editor]");
  const E = ED.els;
  E.projSel = el("select", { class: "ed-projsel", onchange: () => E.projSel.value === "__new" ? edNewDialog() : edOpen(E.projSel.value) });
  E.name = el("input", { type: "text", class: "ed-name", maxlength: 120, onchange: () => edChange(p => p.name = E.name.value.trim() || "Video", { redraw: false }) });
  E.format = el("div", { class: "ed-seg" });
  E.saved = el("span", { class: "muted ed-saved" });
  E.exportBtn = el("button", { class: "btn primary", onclick: edExport }, "Video erstellen");
  E.renderBox = el("div", { class: "ed-render", hidden: true });
  E.lib = el("div", { class: "ed-lib-body" });
  E.libTabs = el("div", { class: "ed-libtabs" });
  E.canvas = el("canvas", { class: "ed-canvas" });
  E.stage = el("div", { class: "ed-stage" }, E.canvas);
  E.time = el("span", { class: "ed-time" });
  E.playBtn = el("button", { class: "btn", title: "Abspielen / Pause (Leertaste)", onclick: edTogglePlay }, "▶");
  E.inspector = el("div", { class: "ed-insp" });
  E.ruler = el("div", { class: "ed-ruler" });
  E.trackV = el("div", { class: "ed-track ed-track-v" });
  E.trackT = el("div", { class: "ed-track ed-track-t" });
  E.trackA = el("div", { class: "ed-track ed-track-a" });
  E.playhead = el("div", { class: "ed-playhead" });
  E.tlInner = el("div", { class: "ed-tl-inner" }, E.ruler, E.trackV, E.trackT, E.trackA, E.playhead);
  E.tl = el("div", { class: "ed-tl" }, E.tlInner);
  E.zoom = el("input", { type: "range", min: 10, max: 240, value: ED.pxs, title: "Zoom", oninput: () => { ED.pxs = +E.zoom.value; edRenderTimeline(); } });
  const tool = (label, title, fn) => el("button", { class: "btn small", title, onclick: fn }, label);
  page.replaceChildren(el("div", { class: "ed" },
    el("div", { class: "ed-top" }, E.projSel, E.name, E.format,
      tool("↶", "Rückgängig (Strg+Z)", () => edUndo(true)), tool("↷", "Wiederholen (Strg+Y)", () => edUndo(false)),
      E.saved, el("span", { class: "spacer" }), tool("Projekt löschen", "", edDeleteProject), E.exportBtn),
    E.renderBox,
    el("div", { class: "ed-main" },
      el("aside", { class: "ed-lib" }, E.libTabs, E.lib),
      el("section", { class: "ed-view" }, E.stage,
        el("div", { class: "ed-transport" },
          tool("⏮", "Zum Anfang", () => edSeek(0)), E.playBtn, E.time, el("span", { class: "spacer" }),
          tool("✂ Schneiden", "Clip an der Abspielposition teilen (S)", edSplit), tool("🗑 Löschen", "Ausgewähltes löschen (Entf)", edDelete))),
      el("aside", { class: "ed-side" }, E.inspector)),
    el("div", { class: "ed-tl-head" },
      el("div", { class: "ed-tracknames" }, el("span", {}, "Video"), el("span", {}, "Text"), el("span", {}, "Ton")),
      el("span", { class: "muted", style: "font-size:12px" }, "Clips ziehen = verschieben · Ränder ziehen = kürzen · Klick in die Leiste = Abspielposition"),
      el("label", { class: "ed-zoom" }, "Zoom", E.zoom)),
    E.tl));
  // Zeitleiste: Klick/Ziehen setzt die Abspielposition
  const seekAt = e => { const r = E.tlInner.getBoundingClientRect(); edSeek((e.clientX - r.left) / ED.pxs); };
  E.ruler.addEventListener("pointerdown", e => {
    seekAt(e);
    const mv = ev => seekAt(ev), up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  });
  for (const tr of [E.trackV, E.trackT, E.trackA]) tr.addEventListener("pointerdown", e => { if (e.target === tr) { ED.sel = null; seekAt(e); edRenderAll(); } });
  // Text in der Vorschau verschieben
  E.canvas.addEventListener("pointerdown", edCanvasDown);
  new ResizeObserver(() => edSizeStage()).observe(E.stage);
  ED.built = true;
}

function edRenderAll() {
  if (!ED.built) return;
  const E = ED.els, p = ED.p;
  E.projSel.replaceChildren(...ED.projects.map(x => el("option", { value: x.id, selected: p && x.id === p.id }, x.name)), el("option", { value: "__new" }, "+ Neues Projekt …"));
  if (!p) return;
  E.name.value = p.name;
  E.format.replaceChildren(...Object.entries(ED_FORMATS).map(([k, [, , label]]) =>
    el("button", { class: "ed-segbtn" + (p.format === k ? " on" : ""), onclick: () => { if (p.format !== k) edChange(q => q.format = k); } }, label)));
  edSaveState();
  edRenderLib(); edSizeStage(); edRenderTimeline(); edRenderInspector(); edDraw();
}

// ---------------------------------------------------------------- Bibliothek (links)
function edRenderLib() {
  const E = ED.els;
  E.libTabs.replaceChildren(...[["media", "Medien"], ["audio", "Musik"], ["text", "Text"]].map(([k, l]) =>
    el("button", { class: "ed-libtab" + (ED.libTab === k ? " on" : ""), onclick: () => { ED.libTab = k; edRenderLib(); } }, l)));
  if (ED.libTab === "media") {
    const q = el("input", { type: "search", placeholder: "Suchen …", class: "ed-libsearch", value: ED.libQ || "", oninput: () => { ED.libQ = q.value; draw(); } });
    const list = el("div", { class: "ed-libgrid" });
    const draw = () => {
      const words = searchWords(ED.libQ || "");
      list.replaceChildren(...state.media.filter(m => mediaMatches(m.title, words)).map(m =>
        el("button", { class: "ed-libitem", title: `${m.title} – zur Zeitleiste hinzufügen`, onclick: () => edAddClip(m) },
          el("span", { class: "ed-libthumb", style: `background-image:url('${thumbUrl(m.id)}')` }, el("i", {}, m.type === "video" ? "▶" : "▣")),
          el("span", { class: "ed-libname" }, m.title))));
      if (!list.childElementCount) list.append(el("div", { class: "muted", style: "font-size:13px" }, state.media.length ? "Nichts gefunden" : "Noch keine Medien – im Reiter „Medien“ hochladen."));
    };
    draw();
    E.lib.replaceChildren(q, el("p", { class: "muted ed-hint" }, "Klick fügt den Clip am Ende an."), list);
  } else if (ED.libTab === "audio") {
    const input = el("input", { type: "file", accept: "audio/*,.mp3,.m4a,.wav,.ogg,.flac", hidden: true, onchange: () => { const f = input.files[0]; input.value = ""; if (f) edUploadAudio(f); } });
    E.audioProgress = el("div", { class: "progress", hidden: true }, el("div"));
    E.lib.replaceChildren(
      el("button", { class: "btn small block", onclick: () => input.click() }, "+ Musik hochladen"), input, E.audioProgress,
      el("p", { class: "muted ed-hint" }, "Klick legt die Musik an die Abspielposition. Bitte nur Musik verwenden, die du für Werbung nutzen darfst."),
      ...ED.audio.map(a => el("div", { class: "ed-audioitem" },
        el("button", { class: "ed-audioadd", title: "An der Abspielposition einfügen", onclick: () => edAddAudio(a) }, "♪ ", el("b", {}, a.name), el("small", { class: "muted" }, edFmtT(a.duration))),
        el("button", { class: "sl-job-del", title: "Musik löschen", onclick: async () => {
          if (!await confirmDlg("Musik löschen?", `„${a.name}“ wird gelöscht. In Projekten verwendete Stellen fallen weg.`)) return;
          await api(`/api/admin/editor/audio/${a.id}`, { method: "DELETE" }); ED.audio = await api("/api/admin/editor/audio"); edRenderLib();
        } }, "×"))));
  } else {
    E.lib.replaceChildren(el("p", { class: "muted ed-hint" }, "Text an der Abspielposition einfügen:"),
      ...ED_TEXT_PRESETS.map(([label, preset]) => el("button", { class: "btn block ed-textpreset", onclick: () => edAddText(preset) }, label)));
  }
}

async function edAddClip(m) {
  const info = await edMediaInfo(m.id).catch(() => null);
  if (!info) { toast("Medium nicht gefunden"); return; }
  const d = m.type === "image" ? 4 : Math.max(0.5, info.duration || 5);
  edChange(p => p.clips.push({ id: edId(), media_id: m.id, in: 0, out: +d.toFixed(3), volume: 1, muted: false, fit: "blur", transition: p.clips.length ? "fade" : "none", transition_s: 0.5, zoom: m.type === "image" ? "in" : "none" }));
  ED.sel = { kind: "clip", id: ED.p.clips[ED.p.clips.length - 1].id };
  edRenderAll();
}
function edAddText(preset) {
  const t = { id: edId(), text: "Text", start: +ED.t.toFixed(2), end: +(ED.t + 3).toFixed(2), x: 0.5, y: 0.5, size: 6, color: "#ffffff", bg: "#000000", bg_on: false, bg_alpha: 0.6, font: "sans-bold", anim: "fade", shadow: true, ...preset };
  t.end = t.start + 3;
  edChange(p => p.texts.push(t));
  ED.sel = { kind: "text", id: t.id }; edRenderAll();
}
function edAddAudio(a) {
  const total = edTimeline().total || a.duration;
  const item = { id: edId(), file_id: a.id, name: a.name, start: +ED.t.toFixed(2), in: 0, out: +Math.min(a.duration, Math.max(1, total - ED.t)).toFixed(2), volume: 0.8, fade_in: 0.5, fade_out: 1.5 };
  edChange(p => p.audio.push(item));
  ED.sel = { kind: "audio", id: item.id }; edRenderAll();
}
async function edUploadAudio(f) {
  const bar = ED.els.audioProgress;
  bar.hidden = false;
  try {
    const { id } = await api("/api/admin/uploads", json("POST", { filename: f.name, size: f.size, kind: "audio" }));
    let off = 0;
    while (off < f.size) {
      const r = await api(`/api/admin/uploads/${id}?offset=${off}`, { method: "PUT", body: f.slice(off, off + CHUNK), headers: { "Content-Type": "application/octet-stream" } });
      off = r.received; bar.firstChild.style.width = Math.round(off / f.size * 100) + "%";
    }
    const a = await api(`/api/admin/uploads/${id}/complete`, json("POST", {}));
    ED.audio = await api("/api/admin/editor/audio");
    toast(`„${a.name}“ hochgeladen`);
  } catch (err) { toast("Fehler: " + err.message); }
  edRenderLib();
}

// ---------------------------------------------------------------- Zeitleiste (unten)
function edSelObj() {
  if (!ED.sel || !ED.p) return null;
  const list = { clip: ED.p.clips, text: ED.p.texts, audio: ED.p.audio }[ED.sel.kind];
  return list?.find(x => x.id === ED.sel.id) || null;
}

function edRenderTimeline() {
  const E = ED.els, p = ED.p, pxs = ED.pxs;
  if (!p) return;
  const { starts, total } = edTimeline();
  const width = Math.max(E.tl.clientWidth - 20, (Math.max(total, ...p.texts.map(t => t.end), ...p.audio.map(a => a.start + a.out - a.in), 10) + 5) * pxs);
  E.tlInner.style.width = width + "px";
  // Lineal
  const step = pxs >= 120 ? 1 : pxs >= 50 ? 2 : pxs >= 25 ? 5 : 10;
  const marks = [];
  for (let s = 0; s * pxs < width; s += step) marks.push(el("span", { style: `left:${s * pxs}px` }, edFmtT(s).replace(/\.0$/, "")));
  E.ruler.replaceChildren(...marks, el("div", { class: "ed-endmark", style: `left:${total * pxs}px`, title: "Ende des Videos" }));
  // Video-Spur
  E.trackV.replaceChildren(...p.clips.map((c, i) => {
    const d = edDur(c), m = mediaById(c.media_id);
    const b = el("div", { class: "ed-clip" + (ED.sel?.id === c.id ? " sel" : ""), style: `left:${starts[i] * pxs}px;width:${Math.max(6, d * pxs)}px;background-image:url('${thumbUrl(c.media_id)}')`, title: m?.title || "" },
      el("span", { class: "ed-clipname" }, (i && c.transition !== "none" ? "⇄ " : "") + (m?.title || "fehlt") + (c.muted ? " 🔇" : "")),
      el("i", { class: "ed-h ed-hl" }), el("i", { class: "ed-h ed-hr" }));
    edDragBlock(b, "clip", c, i);
    return b;
  }));
  // Text- und Tonspur: überlappende Blöcke in eigene Zeilen legen
  const lanes = (items, startOf, endOf) => {
    const ends = [], lane = new Map();
    [...items].sort((a, b) => startOf(a) - startOf(b)).forEach(it => {
      let l = ends.findIndex(e => e <= startOf(it) + 1e-3);
      if (l < 0) { l = ends.length; ends.push(0); }
      ends[l] = endOf(it); lane.set(it, l);
    });
    return { lane, n: Math.max(1, ends.length) };
  };
  const LH = 26;
  const tl = lanes(p.texts, t => t.start, t => t.end);
  E.trackT.style.height = 14 + tl.n * LH + "px";
  E.trackT.replaceChildren(...p.texts.map(t => {
    const b = el("div", { class: "ed-tblock" + (ED.sel?.id === t.id ? " sel" : ""), style: `left:${t.start * pxs}px;width:${Math.max(6, (t.end - t.start) * pxs)}px;top:${12 + tl.lane.get(t) * LH}px;height:${LH - 4}px` },
      el("span", {}, "T  " + t.text.split("\n")[0]), el("i", { class: "ed-h ed-hl" }), el("i", { class: "ed-h ed-hr" }));
    edDragBlock(b, "text", t);
    return b;
  }));
  const al = lanes(p.audio, a => a.start, a => a.start + a.out - a.in);
  E.trackA.style.height = 14 + al.n * LH + "px";
  E.trackA.replaceChildren(...p.audio.map(a => {
    const b = el("div", { class: "ed-ablock" + (ED.sel?.id === a.id ? " sel" : ""), style: `left:${a.start * pxs}px;width:${Math.max(6, (a.out - a.in) * pxs)}px;top:${12 + al.lane.get(a) * LH}px;height:${LH - 4}px` },
      el("span", {}, "♪  " + (a.name || "Musik")), el("i", { class: "ed-h ed-hl" }), el("i", { class: "ed-h ed-hr" }));
    edDragBlock(b, "audio", a);
    return b;
  }));
  edPlayhead();
}

function edPlayhead() {
  const E = ED.els;
  E.playhead.style.left = ED.t * ED.pxs + "px";
  E.time.textContent = `${edFmtT(ED.t)} / ${edFmtT(edTimeline().total)}`;
}

// Ziehen von Blöcken: Mitte = verschieben (Clips: Reihenfolge), Rand = kürzen
function edDragBlock(b, kind, obj, index) {
  b.addEventListener("pointerdown", e => {
    e.stopPropagation(); e.preventDefault();
    if (ED.sel?.id !== obj.id) { ED.sel = { kind, id: obj.id }; edRenderInspector(); b.parentNode.querySelectorAll(".sel").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); edDraw(); }
    const mode = e.target.classList.contains("ed-hl") ? "l" : e.target.classList.contains("ed-hr") ? "r" : "m";
    const x0 = e.clientX, before = JSON.stringify(ED.p), orig = { ...obj };
    const info = kind === "clip" ? ED.info[obj.media_id] : kind === "audio" ? ED.audio.find(a => a.id === obj.file_id) : null;
    const maxLen = info?.type === "image" ? 3600 : info?.duration || 3600;
    let moved = false;
    const mv = ev => {
      const ds = (ev.clientX - x0) / ED.pxs;
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (!moved) return;
      if (kind === "clip") {
        if (mode === "l" && info?.type !== "image") obj.in = Math.min(orig.out - 0.2, Math.max(0, orig.in + ds));
        else if (mode === "r" || (mode === "l" && info?.type === "image")) obj.out = Math.min(maxLen, Math.max(obj.in + 0.2, mode === "r" ? orig.out + ds : orig.out - ds));
        else { // Reihenfolge ändern
          const { starts } = edTimeline();
          const center = starts[ED.p.clips.indexOf(obj)] + edDur(obj) / 2 + ds - (ED._dragShift || 0);
          let target = ED.p.clips.findIndex((c, i) => center < starts[i] + edDur(c) / 2);
          if (target < 0) target = ED.p.clips.length - 1;
          const cur = ED.p.clips.indexOf(obj);
          if (target !== cur) {
            ED.p.clips.splice(cur, 1); ED.p.clips.splice(target, 0, obj);
            ED._dragShift = (ED._dragShift || 0) + (edTimeline().starts[target] - starts[cur]);
          }
        }
      } else {
        const len = (kind === "text" ? orig.end - orig.start : orig.out - orig.in);
        if (mode === "m") {
          const s = Math.max(0, +(orig.start + ds).toFixed(2));
          if (kind === "text") { obj.start = s; obj.end = s + len; } else obj.start = s;
        } else if (kind === "text") {
          if (mode === "l") obj.start = Math.min(orig.end - 0.2, Math.max(0, orig.start + ds));
          else obj.end = Math.max(orig.start + 0.2, orig.end + ds);
        } else {
          if (mode === "l") { const d = Math.min(orig.out - 0.2 - orig.in, Math.max(-orig.in, ds)); obj.in = orig.in + d; obj.start = Math.max(0, orig.start + d); }
          else obj.out = Math.min(maxLen, Math.max(obj.in + 0.2, orig.out + ds));
        }
      }
      edRenderTimeline(); edDraw();
    };
    const up = () => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      ED._dragShift = 0;
      for (const k of ["in", "out", "start", "end"]) if (typeof obj[k] === "number") obj[k] = +obj[k].toFixed(3);
      if (moved) { ED.undo.push(before); ED.redo = []; edDirty(); edRenderAll(); }
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  });
}

function edSplit() {
  const p = ED.p;
  if (!p) return;
  const { starts } = edTimeline();
  // Clip unter der Abspielposition (bzw. ausgewählte Tonspur/Text)
  const s = edSelObj();
  if (ED.sel?.kind === "audio" && s && ED.t > s.start + 0.1 && ED.t < s.start + s.out - s.in - 0.1) {
    edChange(q => { const cut = s.in + (ED.t - s.start); const b = { ...s, id: edId(), start: ED.t, in: cut }; s.out = cut; q.audio.push(b); });
    return;
  }
  if (ED.sel?.kind === "text" && s && ED.t > s.start + 0.1 && ED.t < s.end - 0.1) {
    edChange(q => { const b = { ...s, id: edId(), start: ED.t }; s.end = ED.t; q.texts.push(b); });
    return;
  }
  const i = p.clips.findIndex((c, k) => ED.t > starts[k] + 0.1 && ED.t < starts[k] + edDur(c) - 0.1);
  if (i < 0) { toast("An der Abspielposition ist kein Clip zum Schneiden"); return; }
  edChange(q => {
    const c = q.clips[i], cut = c.in + (ED.t - starts[i]);
    const b = { ...c, id: edId(), in: +cut.toFixed(3), transition: "none" };
    c.out = +cut.toFixed(3);
    q.clips.splice(i + 1, 0, b);
    ED.sel = { kind: "clip", id: b.id };
  });
}

function edDelete() {
  if (!ED.sel) { toast("Erst einen Clip, Text oder Ton auswählen"); return; }
  const { kind, id } = ED.sel;
  edChange(p => { const k = { clip: "clips", text: "texts", audio: "audio" }[kind]; p[k] = p[k].filter(x => x.id !== id); });
  ED.sel = null; edRenderAll();
}

// ---------------------------------------------------------------- Eigenschaften (rechts)
function edField(label, input, unit) { return el("label", { class: "ed-field" }, el("span", {}, label), el("div", { class: "ed-in" }, input, unit ? el("small", { class: "muted" }, unit) : null)); }
function edNum(obj, key, { min = 0, max = 100, step = 0.1, scale = 1, after } = {}) {
  return el("input", { type: "number", min, max, step, value: +(obj[key] * scale).toFixed(3), onchange: e => {
    let v = parseFloat(String(e.target.value).replace(",", ".")); if (isNaN(v)) return;
    v = Math.min(max, Math.max(min, v)) / scale;
    edChange(() => { obj[key] = v; after?.(); });
  } });
}
function edRange(obj, key, { min = 0, max = 1, step = 0.01, fmt = v => `${Math.round(v * 100)} %` } = {}) {
  const out = el("small", { class: "muted ed-rv" }, fmt(obj[key]));
  const r = el("input", { type: "range", min, max, step, value: obj[key], oninput: () => { out.textContent = fmt(+r.value); }, onchange: () => edChange(() => obj[key] = +r.value, { redraw: false }) });
  return el("div", { class: "ed-in" }, r, out);
}
function edSelect(obj, key, choices, after) {
  return el("select", { onchange: e => edChange(() => { obj[key] = e.target.value; after?.(); }) }, ...Object.entries(choices).map(([k, v]) => el("option", { value: k, selected: obj[key] === k }, v)));
}
function edCheck(obj, key, label) {
  const i = el("input", { type: "checkbox", checked: !!obj[key], onchange: () => edChange(() => obj[key] = i.checked) });
  return el("label", { class: "dkj-check" }, i, label);
}

function edRenderInspector() {
  const E = ED.els, p = ED.p, o = edSelObj();
  if (!p) return;
  if (!o) {
    const { total } = edTimeline();
    E.inspector.replaceChildren(el("h3", {}, "Projekt"),
      el("p", { class: "muted", style: "font-size:13px" }, `${ED_FORMATS[p.format][2]} · ${ED_FORMATS[p.format][0]} × ${ED_FORMATS[p.format][1]} · ${edFmtT(total)} · ${p.clips.length} Clips`),
      edField("Gesamtlautstärke", edRange(p, "master_volume", { max: 2 })),
      el("p", { class: "muted", style: "font-size:13px;margin-top:16px" }, "Tipp: Clip, Text oder Ton in der Zeitleiste anklicken, um ihn zu bearbeiten. Tasten: Leertaste = Abspielen, S = Schneiden, Entf = Löschen, Strg+Z = Rückgängig."));
    return;
  }
  if (ED.sel.kind === "clip") {
    const m = mediaById(o.media_id), info = ED.info[o.media_id] || {};
    const isImg = m?.type === "image";
    const i = p.clips.indexOf(o);
    E.inspector.replaceChildren(el("h3", {}, isImg ? "Bild" : "Videoclip"), el("p", { class: "muted ed-insp-sub" }, m?.title || ""),
      ...(isImg ? [edField("Dauer", edNum(o, "out", { min: 0.3, max: 600 }), "s")]
        : [edField("Anfang im Video", edNum(o, "in", { min: 0, max: Math.max(0, o.out - 0.2) }), "s"), edField("Ende im Video", edNum(o, "out", { min: o.in + 0.2, max: info.duration || 3600 }), "s"),
           el("small", { class: "muted" }, `Video ist ${edFmtT(info.duration || 0)} lang · Länge im Schnitt ${edFmtT(edDur(o))}`)]),
      edField("Bild einpassen", edSelect(o, "fit", { blur: "Einpassen, unscharfer Hintergrund", cover: "Füllen (zuschneiden)", contain: "Einpassen mit schwarzen Balken" })),
      edField("Bewegung", edSelect(o, "zoom", { none: "Keine", in: "Langsam hineinzoomen", out: "Langsam herauszoomen" })),
      ...(i > 0 ? [edField("Übergang vom vorigen Clip", edSelect(o, "transition", ED_TRANS)),
                   ...(o.transition !== "none" ? [edField("Dauer des Übergangs", edNum(o, "transition_s", { min: 0.2, max: 2 }), "s")] : [])] : []),
      ...(isImg ? [] : info.has_audio ? [el("h4", {}, "Ton"), edCheck(o, "muted", "Ton stumm"), ...(o.muted ? [] : [edField("Lautstärke", edRange(o, "volume", { max: 2 }))])]
        : [el("p", { class: "muted", style: "font-size:13px" }, "Dieses Video hat keinen Ton.")]));
  } else if (ED.sel.kind === "text") {
    const ta = el("textarea", { rows: 3, onchange: () => edChange(() => o.text = ta.value) }); ta.value = o.text;
    const col = (key) => el("input", { type: "color", value: o[key], onchange: e => edChange(() => o[key] = e.target.value) });
    const pos = el("div", { class: "ed-pos" }, ...[["oben", 0.15], ["Mitte", 0.5], ["unten", 0.85]].map(([l, y]) => el("button", { class: "btn small", onclick: () => edChange(() => { o.y = y; o.x = 0.5; }) }, l)));
    E.inspector.replaceChildren(el("h3", {}, "Text"), edField("Text", ta),
      edField("Schrift", edSelect(o, "font", Object.fromEntries(Object.entries(ED_FONTS).map(([k, v]) => [k, v[2]])))),
      edField("Größe", edNum(o, "size", { min: 1, max: 30, step: 0.5 }), "%"), edField("Farbe", col("color")),
      edCheck(o, "bg_on", "Hintergrund-Balken"), ...(o.bg_on ? [edField("Balkenfarbe", col("bg")), edField("Deckkraft", edRange(o, "bg_alpha"))] : [edCheck(o, "shadow", "Schatten")]),
      edField("Position", pos), el("small", { class: "muted" }, "… oder den Text in der Vorschau mit der Maus verschieben."),
      edField("Animation", edSelect(o, "anim", { fade: "Ein- und ausblenden", slide: "Von unten hereingleiten", none: "Keine" })),
      edField("Start", edNum(o, "start", { min: 0, max: 3600 }), "s"), edField("Ende", edNum(o, "end", { min: o.start + 0.2, max: 3600 }), "s"));
  } else {
    const a = ED.audio.find(x => x.id === o.file_id);
    E.inspector.replaceChildren(el("h3", {}, "Musik / Ton"), el("p", { class: "muted ed-insp-sub" }, o.name || a?.name || ""),
      edField("Lautstärke", edRange(o, "volume", { max: 2 })),
      edField("Einblenden", edNum(o, "fade_in", { min: 0, max: 10 }), "s"), edField("Ausblenden", edNum(o, "fade_out", { min: 0, max: 10 }), "s"),
      edField("Beginnt bei", edNum(o, "start", { min: 0, max: 3600 }), "s"),
      edField("Ausschnitt ab", edNum(o, "in", { min: 0, max: Math.max(0, o.out - 0.2) }), "s"), edField("bis", edNum(o, "out", { min: o.in + 0.2, max: a?.duration || 3600 }), "s"),
      el("small", { class: "muted" }, a ? `Musik ist ${edFmtT(a.duration)} lang` : ""));
  }
}

// ---------------------------------------------------------------- Vorschau
function edSizeStage() {
  const E = ED.els, p = ED.p;
  if (!p) return;
  const [W, H] = ED_FORMATS[p.format];
  const box = E.stage.getBoundingClientRect();
  const s = Math.min(box.width / W, box.height / H) || 0.2;
  E.canvas.width = Math.round(W * Math.min(1, s * (devicePixelRatio || 1)));
  E.canvas.height = Math.round(E.canvas.width * H / W);
  E.canvas.style.width = W * s + "px"; E.canvas.style.height = H * s + "px";
  edDraw();
}

// Medien-Elemente (pro Clip ein <video>/<img>, pro Tonspur ein <audio>)
function edEl(kind, key, src) {
  ED.media = ED.media || {};
  let m = ED.media[key];
  if (!m || m._src !== src) {
    m = kind === "img" ? new Image() : document.createElement(kind);
    if (kind !== "img") { m.preload = "auto"; m.playsInline = true; m.crossOrigin = "use-credentials"; }
    m.src = src; m._src = src;
    if (kind === "img") m.onload = () => edDraw(); else m.addEventListener("seeked", () => { if (!ED.playing) edDraw(); });
    ED.media[key] = m;
  }
  return m;
}

function edActive(t) {
  const { starts } = edTimeline();
  return ED.p.clips.map((c, i) => ({ c, i, start: starts[i] })).filter(x => t >= x.start - 1e-3 && t < x.start + edDur(x.c));
}

function edDrawFit(ctx, src, sw, sh, fit, W, H, zoom) {
  if (!sw || !sh) return;
  const cover = Math.max(W / sw, H / sh), contain = Math.min(W / sw, H / sh);
  if (fit === "blur") {
    ctx.save(); ctx.filter = `blur(${Math.round(W / 40)}px) brightness(0.88)`;
    ctx.drawImage(src, (W - sw * cover) / 2 - W * 0.05, (H - sh * cover) / 2 - H * 0.05, sw * cover * 1.1, sh * cover * 1.1);
    ctx.restore();
  } else if (fit === "contain") { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
  const s = (fit === "cover" ? cover : contain) * zoom;
  ctx.drawImage(src, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
}

function edDraw() {
  const E = ED.els, p = ED.p;
  if (!p || !E.canvas.width) return;
  const ctx = E.canvas.getContext("2d"), W = E.canvas.width, H = E.canvas.height, t = ED.t;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  const act = edActive(t);
  act.forEach((a, n) => {
    const m = mediaById(a.c.media_id); if (!m) return;
    const local = t - a.start, d = edDur(a.c);
    let node, sw, sh;
    if (m.type === "image") { node = edEl("img", "c" + a.c.id, `/api/media/${m.id}/file`); sw = node.naturalWidth; sh = node.naturalHeight; }
    else {
      node = edEl("video", "c" + a.c.id, `/api/media/${m.id}/file`);
      const want = a.c.in + local;
      if (!ED.playing && Math.abs(node.currentTime - want) > 0.04 && node.readyState >= 1) node.currentTime = want;
      if (node.readyState < 2) { node.addEventListener("loadeddata", () => edDraw(), { once: true }); return; }
      sw = node.videoWidth; sh = node.videoHeight;
    }
    const zp = a.c.zoom === "in" ? 1 + 0.12 * local / d : a.c.zoom === "out" ? 1.12 - 0.12 * local / d : 1;
    // Übergang: zweiter aktiver Clip wird über den ersten gelegt
    const trD = Math.min(a.c.transition_s, d / 2);
    const inTr = n > 0 && a.c.transition !== "none" && local < trD;
    const k = inTr ? local / trD : 1;
    ctx.save();
    if (inTr) {
      if (a.c.transition === "fade") ctx.globalAlpha = k;
      else if (a.c.transition === "fadeblack") { ctx.fillStyle = `rgba(0,0,0,${1 - Math.abs(2 * k - 1)})`; if (k < 0.5) { ctx.restore(); ctx.fillRect(0, 0, W, H); return; } ctx.globalAlpha = (k - 0.5) * 2; }
      else if (a.c.transition === "slideleft") ctx.translate(W * (1 - k), 0);
      else if (a.c.transition === "wipeleft") { ctx.beginPath(); ctx.rect(W * (1 - k), 0, W * k, H); ctx.clip(); }
      else if (a.c.transition === "circleopen") { ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.hypot(W, H) / 2 * k, 0, Math.PI * 2); ctx.clip(); }
    }
    edDrawFit(ctx, node, sw, sh, a.c.fit, W, H, zp);
    ctx.restore();
  });
  // Texte
  const scale = W / ED_FORMATS[p.format][0], [FW, FH] = ED_FORMATS[p.format];
  for (const tx of p.texts) {
    if (t < tx.start || t >= tx.end || !tx.text.trim()) continue;
    const fs = Math.max(8, Math.min(FW, FH) * tx.size / 100) * scale;
    const [weight, family] = ED_FONTS[tx.font] || ED_FONTS["sans-bold"];
    ctx.save();
    ctx.font = `${weight} ${fs}px ${family}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    let alpha = 1, dy = 0;
    if (tx.anim !== "none") alpha = Math.max(0, Math.min(1, (t - tx.start) / 0.4, (tx.end - t) / 0.4));
    if (tx.anim === "slide" && t - tx.start < 0.5) dy = (1 - (t - tx.start) / 0.5) * H * 0.05;
    ctx.globalAlpha = alpha;
    const lines = tx.text.split("\n"), lh = fs * 1.25 + (tx.bg_on ? fs * 0.7 : 0);
    lines.forEach((line, li) => {
      if (!line.trim()) return;
      const cx = W * tx.x, cy = H * tx.y + (li - (lines.length - 1) / 2) * lh + dy;
      if (tx.bg_on) {
        const w = ctx.measureText(line).width, pad = fs * 0.35;
        ctx.fillStyle = tx.bg + Math.round(tx.bg_alpha * 255).toString(16).padStart(2, "0");
        ctx.fillRect(cx - w / 2 - pad, cy - fs * 0.62 - pad, w + pad * 2, fs * 1.2 + pad * 2);
      } else if (tx.shadow) { ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowOffsetX = ctx.shadowOffsetY = Math.max(1, fs / 22); }
      ctx.fillStyle = tx.color; ctx.fillText(line, cx, cy);
      ctx.shadowColor = "transparent";
    });
    if (ED.sel?.id === tx.id) { // Auswahlrahmen
      const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + fs, h = lines.length * lh + fs * 0.4;
      ctx.globalAlpha = 1; ctx.setLineDash([6, 4]); ctx.strokeStyle = "#ee7f00"; ctx.lineWidth = 2;
      ctx.strokeRect(W * tx.x - w / 2, H * tx.y - h / 2 + dy, w, h);
    }
    ctx.restore();
  }
  if (!p.clips.length) {
    ctx.fillStyle = "#9aa1ae"; ctx.font = `${Math.round(W / 22)}px sans-serif`; ctx.textAlign = "center";
    ctx.fillText("Links ein Video oder Bild anklicken", W / 2, H / 2);
  }
  edPlayhead();
}

function edCanvasDown(e) {
  const p = ED.p; if (!p) return;
  const r = ED.els.canvas.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  // oberster sichtbarer Text unter dem Zeiger (grob über Größe)
  const hit = [...p.texts].reverse().find(tx => ED.t >= tx.start && ED.t < tx.end &&
    Math.abs(fy - tx.y) < (tx.size / 100) * (Math.min(...ED_FORMATS[p.format]) / ED_FORMATS[p.format][1]) * (tx.text.split("\n").length * 0.9 + 0.6) &&
    Math.abs(fx - tx.x) < 0.45);
  if (!hit) return;
  ED.sel = { kind: "text", id: hit.id }; edRenderInspector(); edRenderTimeline(); edDraw();
  const before = JSON.stringify(p), ox = hit.x - fx, oy = hit.y - fy;
  let moved = false;
  const mv = ev => { moved = true; hit.x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width + ox)); hit.y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height + oy)); edDraw(); };
  const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); if (moved) { hit.x = +hit.x.toFixed(4); hit.y = +hit.y.toFixed(4); ED.undo.push(before); ED.redo = []; edDirty(); } };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
}

// ---------------------------------------------------------------- Abspielen
function edSeek(t) {
  ED.t = Math.max(0, Math.min(t, Math.max(edTimeline().total, 0)));
  if (ED.playing) { edStop(); }
  edDraw();
}
function edTogglePlay() { ED.playing ? edStop() : edPlay(); }
function edPlay() {
  const p = ED.p; if (!p || !p.clips.length) return;
  if (ED.t >= edTimeline().total - 0.05) ED.t = 0;
  ED.playing = true; ED.els.playBtn.textContent = "⏸";
  const t0 = performance.now() - ED.t * 1000;
  const loop = now => {
    if (!ED.playing) return;
    ED.t = (now - t0) / 1000;
    const { total } = edTimeline();
    if (ED.t >= total) { ED.t = total; edStop(); edDraw(); return; }
    edSyncMedia();
    edDraw();
    ED.raf = requestAnimationFrame(loop);
  };
  edSyncMedia();
  ED.raf = requestAnimationFrame(loop);
}
function edStop() {
  ED.playing = false; cancelAnimationFrame(ED.raf);
  if (ED.els.playBtn) ED.els.playBtn.textContent = "▶";
  for (const m of Object.values(ED.media || {})) if (m.pause) m.pause();
}
// Laufende Videos und Musik passend zur Abspielposition starten/stoppen
function edSyncMedia() {
  const p = ED.p, t = ED.t;
  const active = new Set();
  for (const a of edActive(t)) {
    const m = mediaById(a.c.media_id); if (!m || m.type !== "video") continue;
    const v = edEl("video", "c" + a.c.id, `/api/media/${m.id}/file`);
    active.add(v);
    const want = a.c.in + (t - a.start);
    if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = want;
    v.muted = a.c.muted; v.volume = Math.min(1, a.c.volume * p.master_volume);
    if (v.paused) v.play().catch(() => {});
  }
  for (const a of p.audio) {
    const au = edEl("audio", "a" + a.id, `/api/admin/editor/audio/${a.file_id}/file`);
    const local = t - a.start, len = a.out - a.in;
    if (local >= 0 && local < len) {
      active.add(au);
      const want = a.in + local;
      if (Math.abs(au.currentTime - want) > 0.3) au.currentTime = want;
      let vol = a.volume * p.master_volume;
      if (a.fade_in > 0 && local < a.fade_in) vol *= local / a.fade_in;
      if (a.fade_out > 0 && len - local < a.fade_out) vol *= (len - local) / a.fade_out;
      au.volume = Math.max(0, Math.min(1, vol));
      if (au.paused) au.play().catch(() => {});
    }
  }
  for (const m of Object.values(ED.media || {})) if (m.pause && !active.has(m) && !m.paused) m.pause();
}

// ---------------------------------------------------------------- Projekte / Export
async function edNewDialog() {
  ED.els.projSel.value = ED.p?.id || "";
  const res = await dialog("Neues Video", [el("p", {}, "Welches Format?")],
    [["Abbrechen", ""], ["Quadrat 1:1", "square"], ["Querformat 16:9", "landscape"], ["Hochformat 9:16", "portrait", "primary"]]);
  if (res) await edNew(res);
}
async function edDeleteProject() {
  if (!ED.p || !await confirmDlg("Projekt löschen?", `„${ED.p.name}“ wird gelöscht. Bereits erstellte Videos in den Medien bleiben erhalten.`)) return;
  await api(`/api/admin/editor/projects/${ED.p.id}`, { method: "DELETE" });
  ED.p = null; await edLoadProjects();
  if (ED.projects.length) await edOpen(ED.projects[0].id); else await edNew("portrait");
}
async function edExport() {
  const p = ED.p; if (!p) return;
  if (!p.clips.length) { toast("Erst Clips zur Zeitleiste hinzufügen"); return; }
  await edSave();
  const title = el("input", { type: "text", value: p.name, maxlength: 120 });
  const pls = state.playlists.map(pl => ({ pl, cb: el("input", { type: "checkbox" }) }));
  const res = await dialog("Video erstellen", [
    el("p", { class: "muted", style: "font-size:13px" }, `${ED_FORMATS[p.format][2]} · ${edFmtT(edTimeline().total)} · MP4. Der Server rendert das Video und legt es in den Medien ab.`),
    el("label", {}, "Titel in den Medien"), title,
    ...(pls.length ? [el("label", {}, "Gleich zu Playlists hinzufügen"), ...pls.map(x => el("label", { class: "dkj-check" }, x.cb, x.pl.name))] : []),
  ], [["Abbrechen", ""], ["Erstellen", "ok", "primary"]]);
  if (res !== "ok") return;
  try {
    await api(`/api/admin/editor/projects/${p.id}/render`, json("POST", { title: title.value, playlist_ids: pls.filter(x => x.cb.checked).map(x => x.pl.id) }));
    edPollRender();
  } catch (err) { toast(err.message); }
}
function edPollRender() {
  const box = ED.els.renderBox, pid = ED.p.id;
  clearTimeout(ED.renderTimer);
  const tick = async () => {
    const st = await api(`/api/admin/editor/projects/${pid}/render`).catch(() => null);
    if (!st || ED.p?.id !== pid) return;
    box.hidden = false;
    if (st.state === "rendering" || st.state === "saving") {
      box.replaceChildren(el("span", {}, st.state === "saving" ? "Wird in den Medien gespeichert …" : `Video wird erstellt … ${Math.round(st.progress * 100)} %`),
        el("div", { class: "progress" }, el("div", { style: `width:${Math.round(st.progress * 100)}%` })));
      ED.els.exportBtn.disabled = true;
      ED.renderTimer = setTimeout(tick, 1500);
      return;
    }
    ED.els.exportBtn.disabled = false;
    if (st.state === "done") {
      await loadAll();
      box.replaceChildren(el("span", {}, "✓ Fertig – das Video liegt jetzt in den Medien."),
        el("button", { class: "btn small", onclick: () => { const m = mediaById(st.media_id); if (m) preview(m); } }, "Ansehen"),
        el("button", { class: "btn small", onclick: () => { box.hidden = true; } }, "OK"));
      toast("Video erstellt");
    } else if (st.state === "error") {
      box.replaceChildren(el("span", { style: "color:var(--danger)" }, "Erstellen fehlgeschlagen: " + st.error), el("button", { class: "btn small", onclick: () => { box.hidden = true; } }, "OK"));
    } else box.hidden = true;
  };
  tick();
}

// ---------------------------------------------------------------- Reiter
async function showEditor(on) {
  ED.visible = on;
  if (!on) { edStop(); if (!ED.saved) edSave(); return; }
  if (!ED.built) edBuild();
  await edLoadProjects();
  if (!ED.p) {
    let id = null; try { id = localStorage.getItem("edProject"); } catch (e) {}
    const pick = ED.projects.find(x => x.id === id) || ED.projects[0];
    if (pick) await edOpen(pick.id); else await edNew("portrait");
  } else edRenderAll();
}

document.addEventListener("keydown", e => {
  if (!ED.visible || $("#dlg").open || /^(input|textarea|select)$/i.test(document.activeElement?.tagName || "")) return;
  if (e.key === " ") { e.preventDefault(); edTogglePlay(); }
  else if (e.key === "s" || e.key === "S") { e.preventDefault(); edSplit(); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); edDelete(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); edUndo(!e.shiftKey); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); edUndo(false); }
  else if (e.key === "ArrowLeft") { edSeek(ED.t - (e.shiftKey ? 1 : 1 / 30)); }
  else if (e.key === "ArrowRight") { edSeek(ED.t + (e.shiftKey ? 1 : 1 / 30)); }
});
addEventListener("beforeunload", () => { if (ED.p && !ED.saved) edSave(); });
