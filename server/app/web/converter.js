// Reiter "3D-Konverter": beliebige 3D-Datei hochladen → druckbares Modell (STL/3MF/OBJ) bzw. G-Code für den
// Adventurer 5M (über den 3D-Slicer). Die Umwandlung macht der Server (converter.py) mit der passenden Werkzeugkette.
// Nutzt $, el, api, json, toast, confirmDlg, CHUNK, size (index.html), SL/slLoad/slSelect (slicer.js).
"use strict";

const CV = { built: false, visible: false, timer: null, formats: null, jobs: [], viewers: new Map(),
  opts: { unit: "auto", orient: "stable", oversize: "split", scale: 100, quality: "normal", extrude_mm: 3 } };
try { Object.assign(CV.opts, JSON.parse(localStorage.getItem("cvOpts") || "{}")); } catch (e) {}
delete CV.opts.fit; // alte Einstellung (jetzt „Wenn zu groß“)

function cvBuild() {
  const page = $("[data-page=converter]");
  const input = el("input", { type: "file", multiple: true, hidden: true, onchange: () => { const fs = [...input.files]; input.value = ""; fs.forEach(cvUpload); } });
  const drop = el("div", { class: "drop cv-drop", onclick: () => input.click() },
    el("div", { class: "cv-drop-ic" }, "⇪"),
    el("strong", {}, "3D-Datei hierher ziehen – egal welches Format"),
    el("span", {}, "STEP, IGES, FreeCAD, OpenSCAD, Blender, FBX, 3DS, DAE, glTF, USD, OBJ, STL, 3MF, Punktwolken, SVG/DXF, ZIP … bis 500 MB"), input);
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); [...e.dataTransfer.files].forEach(cvUpload); });
  const o = CV.opts, saveO = () => { try { localStorage.setItem("cvOpts", JSON.stringify(o)); } catch (e) {} };
  const sel = (key, choices) => el("select", { onchange: e => { o[key] = e.target.value; saveO(); } },
    ...choices.map(([v, t]) => el("option", { value: v, selected: o[key] === v }, t)));
  const num = (key, min, max, step) => el("input", { type: "number", min, max, step, value: o[key], style: "width:90px", onchange: e => { o[key] = +e.target.value; saveO(); } });
  CV.formatsBox = el("details", { class: "panel cv-formats" }, el("summary", {}, "Welche Formate gehen? (und welche Werkzeuge der Server nutzt)"));
  CV.list = el("div", { class: "cv-list" });
  CV.progress = el("div", { class: "queue" });
  page.replaceChildren(
    el("h2", {}, "3D-Konverter"),
    el("p", { class: "sub" }, "Wandelt fast jede 3D-Datei in ein druckbares Modell für den Adventurer 5M um – repariert, in Millimetern, stabil aufs Druckbett gelegt. Danach als STL/3MF herunterladen oder direkt G-Code erzeugen."),
    drop,
    el("div", { class: "panel cv-opts" },
      el("div", {}, el("label", {}, "Maßeinheit der Datei"), sel("unit", [["auto", "Automatisch erkennen"], ["mm", "Millimeter"], ["cm", "Zentimeter"], ["m", "Meter"], ["in", "Zoll"]])),
      el("div", {}, el("label", {}, "Lage auf dem Druckbett"), sel("orient", [["stable", "Stabil hinlegen (empfohlen)"], ["file", "Wie in der Datei"], ["yup", "„Y oben“ → aufrichten"]])),
      el("div", {}, el("label", {}, "Größe"), el("div", { class: "row" }, num("scale", 1, 1000, 1), "%")),
      el("div", {}, el("label", {}, "Genauigkeit (CAD, Scans)"), sel("quality", [["fein", "Fein"], ["normal", "Normal"], ["grob", "Grob (schnell)"]])),
      el("div", {}, el("label", {}, "Höhe bei 2D (SVG/DXF)"), el("div", { class: "row" }, num("extrude_mm", 0.4, 100, 0.2), "mm")),
      el("div", {}, el("label", {}, "Wenn zu groß fürs Druckbett"), sel("oversize", [["split", "Zerteilen – mit Steckstiften zum Kleben"], ["shrink", "Verkleinern, bis es passt"], ["warn", "Nur Hinweis"]]))),
    CV.progress, CV.formatsBox,
    el("h3", { class: "cv-h" }, "Umwandlungen"), CV.list);
  CV.built = true;
  cvFormats();
}

async function cvFormats() {
  try { CV.formats = await api("/api/admin/convert/formats"); } catch (e) { return; }
  const f = CV.formats, T = f.tools;
  const toolList = [["trimesh", "trimesh – Netze, Reparatur, 2D→3D"], ["gmsh", "gmsh/OpenCASCADE – CAD"], ["openscad", "OpenSCAD"], ["blender", "Blender"],
    ["assimp", "Assimp – ca. 70 Formate"], ["pymeshlab", "MeshLab – VRML, Scans"], ["prusa", "PrusaSlicer – G-Code"]];
  CV.formatsBox.replaceChildren(CV.formatsBox.firstChild,
    el("div", { class: "cv-tools" }, ...toolList.map(([k, l]) => el("span", { class: "cv-tool" + (T[k] ? " on" : "") }, (T[k] ? "✓ " : "✗ ") + l))),
    ...f.groups.map(g => el("div", { class: "cv-fgroup" }, el("b", {}, g.name), el("span", {}, g.ext.join("  ")))),
    el("p", { class: "muted", style: "font-size:13px;margin:8px 0 0" }, `Insgesamt ${f.all.length} Dateiendungen. Nicht möglich: Formate ohne freie Software (z. B. SolidWorks .sldprt, Fusion .f3d, SketchUp .skp) – dort bitte als STEP oder STL exportieren.`));
}

async function cvUpload(f) {
  const row = el("div", { class: "job" }, el("div", { class: "name" }, el("span", {}, f.name), el("span", { class: "muted" }, size(f.size))), el("div", { class: "progress" }, el("div")));
  CV.progress.prepend(row);
  const bar = row.querySelector(".progress div");
  try {
    const { id } = await api("/api/admin/uploads", json("POST", { filename: f.name, size: f.size, kind: "convert", options: CV.opts }));
    let off = 0;
    while (off < f.size) {
      const r = await api(`/api/admin/uploads/${id}?offset=${off}`, { method: "PUT", body: f.slice(off, off + CHUNK), headers: { "Content-Type": "application/octet-stream" } });
      off = r.received; bar.style.width = Math.round(off / f.size * 100) + "%";
    }
    await api(`/api/admin/uploads/${id}/complete`, json("POST", {}));
    row.remove();
    cvLoad();
  } catch (e) { row.classList.add("failed"); row.append(el("small", { class: "dkj-msg bad" }, e.message)); }
}

async function cvLoad() {
  try { CV.jobs = await api("/api/admin/convert/jobs"); } catch (e) { return; }
  cvRender();
  clearTimeout(CV.timer);
  if (CV.visible) CV.timer = setTimeout(cvLoad, CV.jobs.some(j => j.state === "queued" || j.state === "converting") ? 1500 : 10000);
}

const cvKey = j => `${j.id}:${j.state}:${(j.parts || []).map(p => p.slicer_job || "").join(",")}`;
function cvRender() {
  const keep = new Map([...CV.list.children].map(n => [n.dataset.key, n]));
  if (!CV.jobs.length) { CV.list.replaceChildren(el("p", { class: "muted" }, "Noch nichts umgewandelt. Einfach oben eine Datei hineinziehen.")); return; }
  CV.list.replaceChildren(...CV.jobs.map(j => keep.get(cvKey(j)) || cvCard(j)));
}

function cvCard(j) {
  const head = el("div", { class: "cv-head" },
    el("b", { class: "cv-name", title: j.name }, j.name),
    el("span", { class: "cv-ext" }, (j.ext || "").replace(".", "").toUpperCase()),
    el("span", { class: "spacer" }),
    el("small", { class: "muted" }, new Date(j.created * 1000).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })),
    el("button", { class: "sl-job-del", title: "Löschen", onclick: async () => { await api(`/api/admin/convert/jobs/${j.id}`, { method: "DELETE" }); cvLoad(); } }, "×"));
  const card = el("div", { class: "panel cv-card", "data-key": cvKey(j) }, head);
  if (j.state === "queued" || j.state === "converting") {
    card.append(el("div", { class: "cv-busy" }, el("span", { class: "cv-spin" }), j.state === "queued" ? "Wartet …" : "Wird umgewandelt …",
      j.log?.length ? el("small", { class: "muted" }, " · " + j.log[j.log.length - 1]) : null));
  } else if (j.state === "error") {
    card.append(el("div", { class: "dkj-msg bad" }, j.error));
    if (j.log?.length > 1) card.append(el("small", { class: "muted" }, j.log.join(" · ")));
  } else {
    for (const a of j.assemblies || []) card.append(cvAssembly(j, a));
    for (const p of j.parts || []) card.append(cvPart(j, p));
  }
  return card;
}

// Zusammenbau eines zerteilten Modells: Explosionsansicht, welche Teile zusammengehören, alles als ZIP
const CV_COLORS = [0xee7f00, 0x3b82f6, 0x22c55e, 0xa855f7, 0xe5484d, 0x14b8a6, 0xfacc15, 0x64748b];
function cvAssembly(j, a) {
  const parts = j.parts.filter(p => p.split?.group === a.group);
  const view = el("div", { class: "cv-view cv-asm-view" });
  const labels = el("div", { class: "cv-asm-labels" });
  view.append(labels);
  const slider = el("input", { type: "range", min: 0, max: 100, value: 35, title: "Auseinanderziehen" });
  cvViewer(view, parts.map((p, i) => ({ url: `/api/admin/convert/jobs/${j.id}/file/${p.file}`, back: p.split.back, color: CV_COLORS[i % CV_COLORS.length], label: String(p.split.index) })),
    { explode: () => +slider.value / 100, labels });
  const toAll = el("button", { class: "btn small", onclick: async () => {
    toAll.disabled = true;
    try { for (const p of parts) await api(`/api/admin/convert/jobs/${j.id}/to-slicer/${p.file}`, json("POST", {})); toast(`${parts.length} Teile im 3D-Slicer angelegt`); }
    catch (e) { toast(e.message); }
    toAll.disabled = false;
  } }, "Alle Teile in den 3D-Slicer");
  return el("div", { class: "cv-asm" },
    el("div", { class: "cv-asm-head" }, el("b", {}, `✂ In ${a.parts} Teile zerteilt`),
      el("span", { class: "muted" }, ` – Original ${a.size_mm.map(v => dkNum(v, 0)).join(" × ")} mm, zu groß fürs Druckbett`)),
    el("div", { class: "cv-asm-body" },
      el("div", {}, view, el("label", { class: "cv-asm-slider" }, "Zusammen", slider, "Auseinander")),
      el("div", { class: "cv-asm-info" },
        el("p", {}, `Geschnitten wurde an möglichst schmalen Stellen. Jede Schnittfläche hat Löcher für ${a.pins} Steckstifte – die Stifte (eigene Datei) einkleben, dann sitzen die Teile genau aufeinander – wo mehrere Stifte sind, auch nur richtig herum.`),
        el("div", { class: "cv-pairs" }, ...a.pairs.map(pr => el("span", {}, el("i", { style: `background:#${CV_COLORS[(pr.a - 1) % 8].toString(16).padStart(6, "0")}` }), `Teil ${pr.a}`, " + ",
          el("i", { style: `background:#${CV_COLORS[(pr.b - 1) % 8].toString(16).padStart(6, "0")}` }), `Teil ${pr.b}`, el("small", { class: "muted" }, ` · ${pr.pins} Stift${pr.pins === 1 ? "" : "e"}`)))),
        el("ol", { class: "cv-steps" },
          el("li", {}, "Alle Teile und die Steckstifte drucken – die Teile liegen schon richtig auf dem Bett."),
          el("li", {}, "Trocken zusammenstecken und prüfen."),
          el("li", {}, "Kleber in die Löcher und dünn auf die Schnittflächen, zusammendrücken, kurz fixieren.")),
        el("div", { class: "cv-actions" },
          el("a", { class: "btn small primary", href: `/api/admin/convert/jobs/${j.id}/group/${a.group}.zip`, download: "" }, "Alle Teile + Anleitung (ZIP)"),
          toAll))));
}

function cvPart(j, p) {
  const [x, y, z] = p.size_mm;
  const view = el("div", { class: "cv-view" });
  cvViewer(view, `/api/admin/convert/jobs/${j.id}/file/${p.file}`);
  const facts = [
    ["Größe", `${dkNum(x, 1)} × ${dkNum(y, 1)} × ${dkNum(z, 1)} mm`],
    ["Druckbett", p.fits ? "✓ passt" : "✗ zu groß (220 × 220 × 220 mm)"],
    ["Netz", `${dkNum(p.triangles)} Dreiecke · ${p.watertight ? "geschlossen ✓" : "nicht ganz geschlossen – der Slicer repariert das"}`],
    p.volume_cm3 ? ["Volumen", `${dkNum(p.volume_cm3, 1)} cm³ ≈ ${dkNum(p.volume_cm3 * 1.24 * 0.35, 0)}–${dkNum(p.volume_cm3 * 1.24, 0)} g PLA`] : null,
    ["Werkzeug", p.tool],
  ].filter(Boolean);
  const dl = fmt => el("a", { class: "btn small", href: `/api/admin/convert/jobs/${j.id}/file/${p.file}?fmt=${fmt}`, download: "" }, fmt.toUpperCase());
  const toSlicer = async () => {
    if (p.slicer_job) return p.slicer_job;
    const r = await api(`/api/admin/convert/jobs/${j.id}/to-slicer/${p.file}`, json("POST", {}));
    p.slicer_job = r.job?.id || r.job?.jobs?.[0]?.id;
    return p.slicer_job;
  };
  const gcodeBtn = el("button", { class: "btn small primary", disabled: !p.fits, title: p.fits ? "" : "Erst verkleinern (Option oben) und neu umwandeln", onclick: async () => {
    gcodeBtn.disabled = true; gcodeBtn.textContent = "Wird geslict …";
    try {
      const id = await toSlicer();
      for (let i = 0; i < 300; i++) {
        const d = await api("/api/admin/druck/jobs");
        const job = d.jobs.find(x => x.id === id);
        if (job?.state === "failed") throw new Error(job.message || "Slicen fehlgeschlagen");
        if (job?.gcode && job.state !== "slicing") {
          const blob = await (await fetch(`/api/admin/druck/jobs/${id}/preview/gcode`, { credentials: "same-origin" })).blob();
          const a = el("a", { href: URL.createObjectURL(blob), download: `${p.name}.gcode` }); document.body.append(a); a.click(); a.remove();
          toast(`G-Code fertig${job.stats?.time_s ? ` – Druckzeit ca. ${dkDur(job.stats.time_s)}` : ""}`);
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) { toast(e.message); }
    gcodeBtn.disabled = false; gcodeBtn.textContent = "G-Code herunterladen";
  } }, "G-Code herunterladen");
  return el("div", { class: "cv-part" }, view,
    el("div", { class: "cv-info" },
      el("b", { class: "cv-pname" }, p.name),
      el("dl", {}, ...facts.flatMap(([k, v]) => [el("dt", {}, k), el("dd", { class: k === "Druckbett" && !p.fits ? "bad" : "" }, v)])),
      p.notes?.length ? el("div", { class: "cv-notes" }, ...p.notes.map(n => el("span", {}, "✓ " + n))) : null,
      el("div", { class: "cv-actions" },
        el("button", { class: "btn small primary", disabled: !p.fits, onclick: async () => {
          try {
            const id = await toSlicer();
            document.querySelector('nav [data-tab="slicer"]').click();
            for (let i = 0; i < 20 && !SL.jobs.some(x => x.id === id); i++) { await new Promise(r => setTimeout(r, 300)); await slLoad(); }
            if (SL.jobs.some(x => x.id === id)) slSelect(id);
          } catch (e) { toast(e.message); }
        } }, "Im 3D-Slicer öffnen"),
        gcodeBtn, el("span", { class: "muted", style: "font-size:12px" }, "oder"), dl("stl"), dl("3mf"), dl("obj"))));
}

// kleine 3D-Vorschau (dreht sich langsam, Ziehen = drehen). src: URL oder Liste {url, back, color, label} (Zusammenbau)
async function cvViewer(host, src, opt = {}) {
  try {
    const THREE = await import("three");
    const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
    const items = Array.isArray(src) ? src : [{ url: src, color: 0xee7f00 }];
    const geos = await Promise.all(items.map(it => new Promise((res, rej) => new STLLoader().load(it.url, res, undefined, rej))));
    const grp = new THREE.Group();
    const meshes = geos.map((geo, i) => {
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: items[i].color, roughness: 0.55, metalness: 0.05 }));
      if (items[i].back) { const M = new THREE.Matrix4().fromArray(items[i].back.flat()).transpose(); m.applyMatrix4(M); }
      grp.add(m);
      return m;
    });
    const bb = new THREE.Box3().setFromObject(grp), c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
    grp.position.set(-c.x, -c.y, -bb.min.z);
    const base = meshes.map(m => m.position.clone());
    const centers = meshes.map(m => new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()).sub(c));
    const r = Math.max(sz.x, sz.y, sz.z);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    host.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(1, -1.5, 2); scene.add(dl);
    scene.add(grp);
    const grid = new THREE.GridHelper(r * 1.8, 10, 0x888888, 0x555555); grid.rotation.x = Math.PI / 2; grid.material.transparent = true; grid.material.opacity = 0.35; scene.add(grid);
    const cam = new THREE.PerspectiveCamera(35, 1, r / 100, r * 20);
    cam.up.set(0, 0, 1);
    let rot = -0.6, drag = null, alive = true;
    const place = () => { const k = items.length > 1 ? 2.7 : 2.2; cam.position.set(Math.sin(rot) * r * k, -Math.cos(rot) * r * k, r * 1.3 + sz.z * 0.3); cam.lookAt(0, 0, sz.z / 2); };
    renderer.domElement.addEventListener("pointerdown", e => { drag = e.clientX; renderer.domElement.setPointerCapture(e.pointerId); });
    renderer.domElement.addEventListener("pointermove", e => { if (drag != null) { rot -= (e.clientX - drag) * 0.01; drag = e.clientX; } });
    renderer.domElement.addEventListener("pointerup", () => { drag = null; });
    const labels = opt.labels ? items.map(it => { const s = el("span", {}, it.label); opt.labels.append(s); return s; }) : [];
    const loop = () => {
      if (!alive) return;
      if (!host.isConnected) { alive = false; renderer.dispose(); geos.forEach(g => g.dispose()); return; }
      const w = host.clientWidth, h = host.clientHeight;
      if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio())) { renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
      if (drag == null && CV.visible) rot += 0.004;
      const ex = opt.explode ? opt.explode() : 0;
      meshes.forEach((m, i) => m.position.copy(base[i]).addScaledVector(centers[i], ex * 0.9));
      place(); renderer.render(scene, cam);
      labels.forEach((s, i) => {
        const p = new THREE.Box3().setFromObject(meshes[i]).getCenter(new THREE.Vector3()).project(cam);
        s.style.transform = `translate(${(p.x + 1) / 2 * w}px, ${(1 - p.y) / 2 * h}px) translate(-50%, -50%)`;
      });
      requestAnimationFrame(loop);
    };
    loop();
  } catch (e) { host.append(el("span", { class: "muted" }, "Keine Vorschau")); }
}

function showConverter(on) {
  CV.visible = on;
  clearTimeout(CV.timer);
  if (!on) return;
  if (!CV.built) cvBuild();
  cvLoad();
}
