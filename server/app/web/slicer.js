// Reiter "3D-Slicer": Arbeitsbereich wie in einem Slicer-Programm.
// Links Aufträge + Upload, Mitte Live-Vorschau der Druckwege (gcode-preview.js), rechts alle Einstellungen.
// Jede Änderung slict der Server kurz danach neu (Live-Vorschau); "Übernehmen" speichert sie für den Druck,
// "Drucken" übergibt den Auftrag an die Druckmonitor-App, die ihn an den Drucker schickt.
// Nutzt $, el, api, json, toast, dialog, confirmDlg, CHUNK, normText (index.html) und dkNum, dkDur (druck-dashboard.js).
"use strict";

const SL = {
  built: false, visible: false, timer: null, schema: null, jobs: [], printer: {}, sel: null,
  values: null, saved: null, section: null, search: "", preview: null, previewKey: "",
  live: { seq: 0, busy: false, again: false, timer: null, state: "", error: "", stats: null }, last: "",
};
const SL_STATE = {
  slicing: ["Wird geslict …", "warm"], ready: ["Bereit", "ok"], failed: ["Slicen fehlgeschlagen", "bad"],
  queued: ["Wartet auf Druckmonitor …", "warm"], sending: ["Wird übertragen …", "run"], printing: ["An den Drucker geschickt", "ok"],
  error: ["Fehler", "bad"],
};
const SL_QUALITY = { fein: "Fein · 0,12 mm", standard: "Standard · 0,20 mm", schnell: "Schnell · 0,28 mm" };
// Beim Materialwechsel aus der Materialvorlage übernommen
const SL_MAT_KEYS = ["temperature", "first_layer_temperature", "bed_temperature", "first_layer_bed_temperature",
  "filament_density", "filament_max_volumetric_speed", "min_fan_speed", "max_fan_speed"];

const slField = k => SL.schema.fields.find(f => f.key === k);
const slBase = v => ({ ...SL.schema.materials[v.filament_type] || SL.schema.materials.PLA, scale: 100, rotate: 0, rotate_x: 0, rotate_y: 0, duplicate: 1 });
const slChanged = v => { const b = slBase(v); return Object.keys(v).filter(k => b[k] !== undefined && String(b[k]) !== String(v[k])); };
const slSame = (a, b) => JSON.stringify(a, Object.keys(a || {}).sort()) === JSON.stringify(b, Object.keys(b || {}).sort());
const slJob = () => SL.jobs.find(j => j.id === SL.sel);
const slFmt = (f, v) => f.type === "bool" ? (v ? "an" : "aus") : f.type === "select" ? (f.choices.find(c => c[0] === v) || [v, v])[1]
  : `${dkNum(v, f.type === "int" ? 0 : (String(f.step || 1).split(".")[1] || "").length)}${f.unit ? " " + f.unit : ""}`;

function slApplyMaterial(v, mat) {
  const m = SL.schema.materials[mat];
  if (!m) return;
  v.filament_type = mat;
  for (const k of SL_MAT_KEYS) if (m[k] !== undefined) v[k] = m[k];
}

// Optionen eines Auftrags als vollständige Werte (Aufträge der ersten Version umrechnen)
function slJobValues(j) {
  const o = j.options || {};
  if (o.material || o.quality) {
    const v = { ...(SL.schema.materials[o.material] || SL.schema.materials.PLA) };
    v.layer_height = SL.schema.qualities[o.quality] || v.layer_height;
    v.fill_density = o.infill ?? v.fill_density; v.support_material = !!o.supports;
    if (!o.brim) v.brim_type = "no_brim";
    return v;
  }
  return { ...slBase(o), ...o };
}

// ---------------------------------------------------------------- Aufbau
function slBuild() {
  const page = $("[data-page=slicer]");
  const R = SL.r = {};
  const input = el("input", { type: "file", accept: ".stl,.3mf,.obj,.zip,.gcode,.gco,.g,.gx", hidden: true, onchange: () => { const f = input.files[0]; input.value = ""; if (f) slUpload(f); } });
  R.drop = el("div", { class: "drop sl-drop", onclick: () => input.click() },
    el("strong", {}, "+ Modell hinzufügen"), el("span", {}, "STL, 3MF, OBJ, ZIP oder fertiger G-Code"), input);
  // Thingiverse-Link
  R.tvInput = el("input", { type: "url", placeholder: "Thingiverse-Link einfügen …", class: "sl-tv-input",
    onkeydown: e => { if (e.key === "Enter") slThingiverse(); } });
  R.tvBtn = el("button", { class: "btn small primary", onclick: slThingiverse }, "Laden");
  R.tv = el("div", { class: "sl-tv" }, R.tvInput, R.tvBtn,
    el("button", { class: "btn small", title: "Thingiverse einrichten", onclick: () => slTvSetup() }, "⚙"));
  R.drop.addEventListener("dragover", e => { e.preventDefault(); R.drop.classList.add("over"); });
  R.drop.addEventListener("dragleave", () => R.drop.classList.remove("over"));
  R.drop.addEventListener("drop", e => { e.preventDefault(); R.drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) slUpload(f); });
  R.progress = el("div", { class: "progress", hidden: true }, el("div"));
  R.printer = el("div", { class: "sl-printer" });
  R.jobs = el("div", { class: "sl-jobs" });
  R.viewHost = el("div", { class: "sl-view-host" });
  R.viewTop = el("div", { class: "sl-view-top" });
  R.empty = el("div", { class: "sl-empty" }, el("strong", {}, "Noch kein Modell gewählt"), el("span", {}, "Links ein Modell hinzufügen oder einen Auftrag auswählen."));
  R.panel = el("div", { class: "sl-panel-body" });
  R.actions = el("div", { class: "sl-actions" });
  page.replaceChildren(el("div", { class: "sl ov" },
    el("aside", { class: "sl-side" },
      el("div", { class: "sl-side-head" }, el("h2", {}, "3D-Slicer"), el("p", { class: "sub" }, "Flashforge Adventurer 5M · 220 × 220 × 220 mm")),
      R.drop, R.tv, R.progress, R.printer, el("div", { class: "sl-label" }, "Aufträge"), R.jobs),
    el("section", { class: "sl-view" }, R.viewTop, R.viewHost, R.empty),
    el("aside", { class: "sl-panel" }, R.panel, R.actions)));
  SL.built = true;
  import("/gcode-preview.js").then(({ GcodePreview }) => {
    SL.preview = new GcodePreview(R.viewHost);
    slShowPreview(true);
  }).catch(e => { R.viewHost.textContent = "Vorschau nicht möglich: " + e.message; });
}

// ---------------------------------------------------------------- Laden
async function slLoad() {
  try {
    if (!SL.schema) {
      SL.schema = await api("/api/admin/druck/slicer");
      SL.values = { ...(SL.schema.user_defaults || SL.schema.materials.PLA) };
      SL.section = SL.schema.sections[0];
    }
    const d = await api("/api/admin/druck/jobs");
    SL.jobs = d.jobs; SL.printer = d.printer || {};
    if (!SL.built) slBuild();
    const key = JSON.stringify(d);
    if (key !== SL.last) {
      SL.last = key;
      if (SL.sel && !slJob()) SL.sel = null;
      slRenderJobs(); slRenderActions(); slShowPreview();
      if (!SL.panelBuilt) { slRenderPanel(); SL.panelBuilt = true; }
    }
  } catch (e) { /* nächster Versuch */ }
}

function showSlicer(on) {
  SL.visible = on;
  clearInterval(SL.timer); SL.timer = null;
  if (!on) return;
  slLoad();
  SL.timer = setInterval(() => { if (!document.hidden) slLoad(); }, 3000);
}

// ---------------------------------------------------------------- Aufträge (links)
function slPrinterReady() {
  const p = SL.printer;
  if (!p.app_online) return [false, "Druckmonitor-App nicht verbunden"];
  if (!p.can_upload) return [false, "Seriennummer/Prüfcode fehlen in der Druckmonitor-App"];
  if (!p.online) return [false, "Drucker nicht erreichbar"];
  if (!["idle", "done"].includes(p.state)) return [false, `Drucker beschäftigt (${p.status || p.state})`];
  return [true, "Drucker bereit"];
}

function slRenderJobs() {
  const R = SL.r;
  const [ready, why] = slPrinterReady();
  R.printer.replaceChildren(el("span", { class: "dot" + (ready ? " on" : "") }), why);
  if (!SL.jobs.length) { R.jobs.replaceChildren(el("div", { class: "muted sl-nojobs" }, "Noch keine Aufträge.")); return; }
  R.jobs.replaceChildren(...SL.jobs.map(j => {
    const [label, cls] = SL_STATE[j.state] || [j.state, "idle"];
    const st = j.stats || {};
    const facts = [st.time_s ? dkDur(st.time_s) : null, st.filament_g ? `${dkNum(st.filament_g, 0)} g` : null].filter(Boolean).join(" · ");
    return el("div", { class: "sl-job" + (j.id === SL.sel ? " active" : ""), onclick: () => slSelect(j.id) },
      el("div", { class: "sl-job-name", title: j.file_name || j.name }, j.name),
      el("div", { class: "sl-job-meta" }, el("span", { class: `dk-state ${cls}` }, el("i"), el("span", {}, label)), facts ? el("span", { class: "muted" }, facts) : null),
      j.origin ? el("div", { class: "sl-origin" }, `${j.origin.site}${j.origin.creator ? " · " + j.origin.creator : ""}${j.origin.license ? " · " + j.origin.license : ""}`) : null,
      j.message && ["failed", "error"].includes(j.state) ? el("div", { class: "dkj-msg bad" }, j.message) : null,
      !["slicing", "queued", "sending"].includes(j.state) ? el("button", { class: "sl-job-del", title: "Auftrag löschen", onclick: async e => {
        e.stopPropagation();
        if (!await confirmDlg("Auftrag löschen?", `„${j.name}“ wird vom Server gelöscht.`)) return;
        await api(`/api/admin/druck/jobs/${j.id}`, { method: "DELETE" });
        if (SL.sel === j.id) SL.sel = null;
        SL.last = ""; slLoad();
      } }, "×") : null);
  }));
}

function slSelect(id) {
  SL.sel = id;
  const j = slJob();
  if (j && !j.sliced_by_user) { SL.values = slJobValues(j); SL.saved = { ...SL.values }; }
  SL.live.state = ""; SL.live.error = ""; SL.live.stats = null;
  slRenderJobs(); slRenderPanel(); slRenderActions(); slShowPreview(true);
}

// ---------------------------------------------------------------- Vorschau (Mitte)
function slStatsBar(stats, note) {
  const st = stats || {};
  const parts = [
    st.time_s ? ["Druckzeit", dkDur(st.time_s)] : null,
    st.filament_g ? ["Filament", `${dkNum(st.filament_g, 0)} g`] : st.filament_m ? ["Filament", `${dkNum(st.filament_m, 1)} m`] : null,
    st.layers ? ["Schichten", dkNum(st.layers)] : null,
  ].filter(Boolean);
  SL.r.viewTop.replaceChildren(...parts.map(([k, v]) => el("div", {}, el("small", {}, k), el("b", {}, v))),
    ...(note ? [el("div", { class: "sl-note" }, note)] : []));
}

// Vorschau des gespeicherten G-Codes des Auftrags (sofern keine Live-Vorschau mit geänderten Werten läuft)
function slShowPreview(force) {
  const j = slJob(), R = SL.r;
  R.empty.hidden = !!j;
  if (!SL.preview) return;
  if (!j) { SL.preview.clear(); SL.previewKey = ""; slStatsBar(null); SL.preview.setBusy(""); return; }
  const changed = SL.saved && !j.sliced_by_user && !slSame(SL.values, SL.saved);
  if (changed || SL.live.state) return; // Live-Vorschau hat Vorrang
  if (j.state === "slicing") { SL.preview.setBusy("Wird geslict …"); slStatsBar(null); return; }
  if (!j.gcode) { SL.preview.setBusy(""); SL.preview.setMessage(j.state === "failed" ? j.message : "Noch keine Vorschau"); slStatsBar(null); return; }
  const key = `${j.id}:${j.sliced_at || j.created}`;
  slStatsBar(j.stats, j.sliced_by_user ? "Eigener G-Code" : "");
  if (key === SL.previewKey && !force) return;
  SL.previewKey = key;
  SL.preview.setBusy("Lade Vorschau …"); SL.preview.setMessage("");
  SL.preview.loadUrl(`/api/admin/druck/jobs/${j.id}/preview/gcode`)
    .then(() => SL.preview.setBusy(""))
    .catch(e => { SL.preview.setBusy(""); SL.preview.setMessage(e.message); });
}

// Live-Vorschau: kurz nach der letzten Änderung neu slicen (immer nur eine Anfrage gleichzeitig)
function slScheduleLive() {
  const j = slJob();
  slRenderActions();
  if (!j || j.sliced_by_user || !SL.preview) return;
  clearTimeout(SL.live.timer);
  if (slSame(SL.values, SL.saved)) { SL.live.state = ""; SL.previewKey = ""; slShowPreview(true); return; }
  SL.live.state = "wait";
  SL.preview.setBusy("Vorschau wird neu berechnet …");
  SL.live.timer = setTimeout(slRunLive, 700);
}

async function slRunLive() {
  if (SL.live.busy) { SL.live.again = true; return; }
  const j = slJob();
  if (!j) return;
  SL.live.busy = true; SL.live.again = false;
  const seq = ++SL.live.seq, values = { ...SL.values };
  SL.preview.setBusy("Wird geslict …");
  try {
    const r = await api(`/api/admin/druck/jobs/${j.id}/live`, json("POST", { values }));
    if (seq === SL.live.seq && SL.sel === j.id) {
      if (r.ok) {
        await SL.preview.loadUrl(r.url);
        SL.preview.setMessage("");
        SL.previewKey = "";
        SL.live.state = "done"; SL.live.error = ""; SL.live.stats = r.stats;
        slStatsBar(r.stats, slSame(SL.values, SL.saved) ? "" : "Vorschau mit geänderten Einstellungen – noch nicht übernommen");
      } else {
        SL.live.state = "error"; SL.live.error = r.error;
        SL.preview.setMessage(r.error);
      }
    }
  } catch (e) { SL.preview.setMessage(e.message); }
  SL.live.busy = false;
  if (SL.live.again) slRunLive();
  else { SL.preview.setBusy(""); slRenderActions(); }
}

// ---------------------------------------------------------------- Einstellungen (rechts)
function slInput(f, value, onChange) {
  if (f.type === "bool") { const i = el("input", { type: "checkbox", checked: !!value, onchange: () => onChange(i.checked) }); return i; }
  if (f.type === "select") { const i = el("select", { onchange: () => onChange(i.value) }, ...f.choices.map(([v, t]) => el("option", { value: v, selected: v === value }, t))); return i; }
  const i = el("input", { type: "number", min: f.min, max: f.max, step: f.step || 1, value,
    onchange: () => { let v = parseFloat(String(i.value).replace(",", ".")); if (isNaN(v)) v = value; v = Math.min(f.max ?? v, Math.max(f.min ?? v, v)); i.value = v; onChange(v); } });
  return i;
}

function slSet(k, val) {
  if (k === "filament_type") slApplyMaterial(SL.values, val); else SL.values[k] = val;
  slRenderPanel();
  slScheduleLive();
}

function slRenderPanel() {
  const R = SL.r, v = SL.values, S = SL.schema;
  if (!R || !v) return;
  const j = slJob();
  if (j?.sliced_by_user) {
    R.panel.replaceChildren(el("div", { class: "sl-info" }, el("strong", {}, "Fertiger G-Code"),
      el("p", {}, "Dieser Auftrag wurde schon geslict hochgeladen (z. B. aus Flash Studio). Er wird so gedruckt, wie er ist – Einstellungen lassen sich hier nicht ändern.")));
    return;
  }
  const scrollTop = R.panel.querySelector(".sl-rows")?.scrollTop || 0;
  // Schnellauswahl
  const quality = Object.entries(S.qualities).find(([, h]) => Math.abs(h - v.layer_height) < 1e-6)?.[0] || "eigene";
  const mat = el("select", { onchange: () => slSet("filament_type", mat.value) },
    ...slField("filament_type").choices.filter(([k]) => S.materials[k]).map(([k, t]) => el("option", { value: k, selected: v.filament_type === k }, t)));
  const qual = el("select", { onchange: () => { if (S.qualities[qual.value]) slSet("layer_height", S.qualities[qual.value]); } },
    ...Object.entries(SL_QUALITY).map(([k, t]) => el("option", { value: k, selected: quality === k }, t)),
    ...(quality === "eigene" ? [el("option", { value: "eigene", selected: true }, `Eigene · ${dkNum(v.layer_height, 2)} mm`)] : []));
  const infillVal = el("b", {}, `${dkNum(v.fill_density)} %`);
  const infill = el("input", { type: "range", min: 0, max: 100, step: 5, value: v.fill_density,
    oninput: () => { infillVal.textContent = `${infill.value} %`; }, onchange: () => slSet("fill_density", +infill.value) });
  const sup = el("input", { type: "checkbox", checked: v.support_material, onchange: () => { if (sup.checked) v.support_material_auto = true; slSet("support_material", sup.checked); } });
  const brimOn = v.brim_type !== "no_brim" && v.brim_width > 0;
  const brim = el("input", { type: "checkbox", checked: brimOn, onchange: () => {
    if (brim.checked) { if (v.brim_type === "no_brim") v.brim_type = "outer_only"; if (!(v.brim_width > 0)) v.brim_width = 5; slSet("brim_type", v.brim_type); }
    else slSet("brim_type", "no_brim");
  } });
  const warn = ["ABS", "ASA", "PC", "PA"].includes(v.filament_type) ? `${v.filament_type} nur mit geschlossenem Gehäuse (Adventurer 5M Pro).` : v.filament_type === "TPU" ? "TPU wird sehr langsam gedruckt." : "";
  const quick = el("div", { class: "sl-quick" },
    el("label", {}, "Material", mat), el("label", {}, "Qualität", qual),
    el("label", { class: "sl-wide" }, el("span", {}, "Füllung ", infillVal), infill),
    el("label", { class: "dkj-check" }, sup, "Stützen"), el("label", { class: "dkj-check" }, brim, "Rand (Brim)"),
    ...(warn ? [el("div", { class: "dkj-warn" }, warn)] : []));

  // Alle Einstellungen: Reiter + Suche
  const changed = new Set(slChanged(v)), base = slBase(v);
  const search = el("input", { type: "search", class: "dkj-search", placeholder: "Einstellung suchen …", value: SL.search,
    oninput: () => { SL.search = search.value; slRenderPanel(); const s = SL.r.panel.querySelector(".dkj-search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
  const q = normText(SL.search.trim());
  const tabs = el("div", { class: "dkj-tabs" }, ...S.sections.map(s => {
    const n = S.fields.filter(f => f.section === s && changed.has(f.key)).length;
    return el("button", { type: "button", class: "dkj-tab" + (s === SL.section && !q ? " active" : ""), onclick: () => { SL.section = s; SL.search = ""; slRenderPanel(); } }, s, n ? el("b", {}, String(n)) : null);
  }));
  const list = S.fields.filter(f => q ? normText(f.label + " " + f.section).includes(q) : f.section === SL.section);
  const rows = el("div", { class: "sl-rows" }, ...(list.length ? list.map(f => el("div", { class: "dkj-row" + (changed.has(f.key) ? " changed" : "") },
    el("label", {}, el("span", {}, f.label), q ? el("small", {}, f.section) : null, f.hint ? el("small", {}, f.hint) : null),
    el("div", { class: "dkj-in" }, slInput(f, v[f.key], val => slSet(f.key, val)), f.unit && f.type !== "bool" ? el("span", { class: "muted" }, f.unit) : null),
    changed.has(f.key) ? el("button", { type: "button", class: "dkj-reset", title: `Zurück auf ${slFmt(f, base[f.key])}`, onclick: () => slSet(f.key, base[f.key]) }, "↺") : el("span")))
    : [el("div", { class: "muted", style: "padding:12px 0" }, "Keine passende Einstellung.")]));
  R.panel.replaceChildren(quick,
    el("div", { class: "sl-all-head" }, el("strong", {}, "Alle Einstellungen"),
      el("span", { class: "muted" }, changed.size ? `${changed.size} geändert` : "wie Materialvorlage")),
    search, tabs, rows);
  rows.scrollTop = scrollTop;
}

function slRenderActions() {
  const R = SL.r;
  if (!R) return;
  const j = slJob();
  const dirty = j && !j.sliced_by_user && SL.saved && !slSame(SL.values, SL.saved);
  const [ready, why] = slPrinterReady();
  const canPrint = j && !dirty && ready && ["ready", "error", "printing"].includes(j.state);
  const status = !j ? "Einstellungen gelten für das nächste hochgeladene Modell."
    : dirty ? (SL.live.state === "error" ? "Mit diesen Einstellungen geht es nicht: " + SL.live.error : "Geänderte Einstellungen – „Übernehmen“ speichert sie für den Druck.")
    : j.state === "slicing" ? "Wird geslict …" : j.state === "failed" ? j.message : !ready ? why : "Bereit zum Drucken.";
  R.actions.replaceChildren(
    el("div", { class: "sl-status" + (dirty ? " dirty" : "") }, status),
    el("div", { class: "sl-buttons" },
      j && dirty ? el("button", { class: "btn small", onclick: () => { SL.values = { ...SL.saved }; SL.live.state = ""; slRenderPanel(); slScheduleLive(); } }, "Verwerfen") : null,
      el("button", { class: "btn small", title: "Diese Einstellungen für künftige Uploads vorauswählen", onclick: async () => {
        await api("/api/admin/druck/slicer/defaults", json("PUT", { values: SL.values })); toast("Als Standard gespeichert");
      } }, "Als Standard"),
      j && dirty ? el("button", { class: "btn small primary", disabled: SL.live.state === "error", onclick: slCommit }, "Übernehmen") : null,
      j ? el("button", { class: "btn primary", disabled: !canPrint, title: canPrint ? "" : dirty ? "Erst übernehmen" : why, onclick: () => slPrint(j) }, "Drucken") : null));
}

async function slCommit() {
  const j = slJob();
  try {
    await api(`/api/admin/druck/jobs/${j.id}/slice`, json("POST", { values: SL.values }));
    SL.saved = { ...SL.values }; SL.live.state = "";
    toast("Übernommen");
  } catch (err) { toast(err.message); }
  SL.last = ""; slLoad();
}

async function slPrint(j) {
  const matName = j.options?.filament_type || j.options?.material;
  const mat = j.sliced_by_user || !matName ? "Das passende Filament" : `${matName}-Filament`;
  const c1 = el("input", { type: "checkbox" }), c2 = el("input", { type: "checkbox" }), lev = el("input", { type: "checkbox", checked: true });
  const content = [
    el("p", {}, `„${j.name}“ wird an den Drucker geschickt und startet sofort` + (j.stats?.time_s ? ` (ca. ${dkDur(j.stats.time_s)}).` : ".")),
    el("label", { class: "dkj-check" }, c1, "Das Druckbett ist leer und sauber"),
    el("label", { class: "dkj-check" }, c2, `${mat} ist eingelegt`),
    el("label", { class: "dkj-check" }, lev, "Vor dem Druck das Bett vermessen (empfohlen)"),
  ];
  if (await dialog("Jetzt drucken?", content, [["Abbrechen", ""], ["Drucken", "ok", "primary"]]) !== "ok") return;
  if (!c1.checked || !c2.checked) { toast("Bitte erst Druckbett und Filament prüfen und beides abhaken"); return; }
  try {
    await api(`/api/admin/druck/jobs/${j.id}/print`, json("POST", { leveling: lev.checked }));
    toast("Wird an die Druckmonitor-App übergeben …");
  } catch (err) { toast(err.message); }
  SL.last = ""; slLoad();
}

async function slUpload(f) {
  const R = SL.r, bar = R.progress.firstChild;
  R.progress.hidden = false; bar.style.width = "0%";
  try {
    const { id } = await api("/api/admin/uploads", json("POST", { filename: f.name, size: f.size, kind: "druckjob", options: SL.values }));
    let off = 0;
    while (off < f.size) {
      const r = await api(`/api/admin/uploads/${id}?offset=${off}`, { method: "PUT", body: f.slice(off, off + CHUNK), headers: { "Content-Type": "application/octet-stream" } });
      off = r.received; bar.style.width = Math.round(off / f.size * 100) + "%";
    }
    const job = await api(`/api/admin/uploads/${id}/complete`, json("POST", {}));
    toast(job.jobs?.length > 1 ? `${job.jobs.length} Modelle aus der ZIP-Datei werden geslict …`
      : job.state === "slicing" ? `„${job.name}“ wird geslict …` : `„${job.name}“ ist bereit`);
    SL.last = ""; await slLoad();
    slSelect(job.id);
  } catch (err) { toast("Fehler: " + err.message); }
  R.progress.hidden = true;
}

// ---------------------------------------------------------------- Thingiverse
async function slTvSetup(after) {
  const st = await api("/api/admin/druck/thingiverse").catch(() => ({}));
  const tok = el("input", { type: "password", placeholder: st.configured ? "•••••• (gespeichert – leer lassen zum Behalten)" : "App Token", autocomplete: "off" });
  const steps = el("ol", { class: "sl-steps" },
    el("li", {}, "Bei ", el("a", { href: "https://www.thingiverse.com", target: "_blank", rel: "noopener" }, "thingiverse.com"), " anmelden (kostenlos)."),
    el("li", {}, el("a", { href: "https://www.thingiverse.com/apps/create", target: "_blank", rel: "noopener" }, "Neue App anlegen"), " (Developers → Create an App): Typ „Web App“, Name z. B. „Retail Demo“, Rest beliebig."),
    el("li", {}, "Auf der Seite der App den „App Token“ kopieren und hier einfügen."));
  const res = await dialog("Thingiverse einrichten", [
    el("p", {}, "Damit der Server Modelle von Thingiverse laden darf, braucht er einen kostenlosen Zugangsschlüssel der offiziellen Thingiverse-Schnittstelle."),
    steps, el("label", {}, "App Token"), tok,
  ], [["Abbrechen", ""], ...(st.configured ? [["Schlüssel entfernen", "del"]] : []), ["Speichern", "ok", "primary"]]);
  try {
    if (res === "del") { await api("/api/admin/druck/thingiverse", json("PUT", { token: "" })); toast("Schlüssel entfernt"); return; }
    if (res !== "ok") return;
    if (tok.value.trim()) { await api("/api/admin/druck/thingiverse", json("PUT", { token: tok.value.trim() })); toast("Gespeichert"); }
    if (after) after();
  } catch (err) { toast(err.message); }
}

async function slThingiverse() {
  const R = SL.r, url = R.tvInput.value.trim();
  if (!url) { R.tvInput.focus(); return; }
  const st = await api("/api/admin/druck/thingiverse").catch(() => ({}));
  if (!st.configured) { slTvSetup(slThingiverse); return; }
  R.tvBtn.disabled = true; R.tvBtn.textContent = "Lädt …";
  let thing;
  try { thing = await api("/api/admin/druck/thingiverse/lookup", json("POST", { url })); }
  catch (err) { R.tvBtn.disabled = false; R.tvBtn.textContent = "Laden"; dialog("Thingiverse", el("p", {}, err.message), [["OK", ""]]); return; }
  R.tvBtn.disabled = false; R.tvBtn.textContent = "Laden";
  const boxes = thing.files.map(f => {
    const cb = el("input", { type: "checkbox", checked: f.supported, disabled: !f.supported, value: f.id });
    return { f, cb, row: el("label", { class: "sl-tv-file" + (f.supported ? "" : " off") },
      cb, f.thumbnail ? el("img", { src: f.thumbnail, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : el("span", { class: "sl-tv-noimg" }),
      el("span", { class: "sl-tv-fname" }, f.name), el("span", { class: "muted" }, f.supported ? (f.size ? size(f.size) : "") : "nicht druckbar")) };
  });
  const head = el("div", { class: "sl-tv-head" },
    thing.thumbnail ? el("img", { src: thing.thumbnail, alt: "", referrerpolicy: "no-referrer" }) : null,
    el("div", {}, el("strong", {}, thing.name),
      el("div", { class: "muted" }, [thing.creator && `von ${thing.creator}`, thing.license].filter(Boolean).join(" · ")),
      el("a", { href: thing.url, target: "_blank", rel: "noopener" }, "Auf Thingiverse ansehen ↗")));
  const res = await dialog("Von Thingiverse importieren", [head,
    el("p", { class: "muted", style: "font-size:13px" }, "Welche Dateien sollen in den Slicer? Jede wird ein eigener Auftrag und mit den aktuellen Einstellungen geslict. Bitte die Lizenz des Modells beachten."),
    el("div", { class: "sl-tv-files" }, ...boxes.map(b => b.row))],
    [["Abbrechen", ""], ["Importieren", "ok", "primary"]]);
  if (res !== "ok") return;
  const ids = boxes.filter(b => b.cb.checked).map(b => b.f.id);
  if (!ids.length) { toast("Keine Datei ausgewählt"); return; }
  R.tvBtn.disabled = true; R.tvBtn.textContent = "Lädt …";
  try {
    const r = await api("/api/admin/druck/thingiverse/import", json("POST", { thing_id: thing.id, file_ids: ids, values: SL.values }));
    toast(`${r.jobs.length} Datei${r.jobs.length > 1 ? "en" : ""} von Thingiverse geladen – wird geslict …`);
    R.tvInput.value = "";
    SL.last = ""; await slLoad();
    slSelect(r.jobs[0].id);
  } catch (err) { dialog("Thingiverse", el("p", {}, err.message), [["OK", ""]]); }
  R.tvBtn.disabled = false; R.tvBtn.textContent = "Laden";
}
