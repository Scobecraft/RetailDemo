// G-Code-Vorschau wie im Slicer: Druckwege nach Art eingefärbt (Wände, Füllung, Stützen …),
// Schicht-Schieberegler, Legende zum Ein-/Ausblenden, Druckbett 220 × 220 mm, drehen/zoomen/verschieben.
import * as THREE from 'three';

// Art der Druckwege: Erkennung aus den ";TYPE:"-Kommentaren von PrusaSlicer, OrcaSlicer, Flash Studio, Cura
const TYPES = [
  ['outer', 'Außenwand', '#ee7f00', /external|outer|wall-outer/i],
  ['wall', 'Wände', '#ffc266', /perimeter|inner wall|wall-inner|^wall/i],
  ['top', 'Oberseite', '#e5484d', /top/i],
  ['solid', 'Massive Füllung', '#a855f7', /solid|bottom|skin/i],
  ['bridge', 'Brücken', '#3b82f6', /bridge/i],
  ['infill', 'Füllung', '#b4532a', /infill|fill/i],
  ['support', 'Stützen', '#22c55e', /support(?!.*interface)/i],
  ['interface', 'Stützen-Kontakt', '#a3e635', /interface/i],
  ['brim', 'Rand / Skirt', '#94a3b8', /skirt|brim/i],
  ['ironing', 'Bügeln', '#facc15', /ironing/i],
  ['gap', 'Lücken', '#f1f5f9', /gap/i],
  ['other', 'Sonstiges', '#64748b', /./],
];
const TRAVEL = ['travel', 'Leerfahrten', '#38bdf8'];
// gehören nicht zum fertigen Teil (Abmessungen ohne Stützen, Rand und Reinigungslinie)
const NOT_PART = new Set(['support', 'interface', 'brim', 'other', 'travel']);

// Längen in mm oder cm (Einheit wird im Browser gemerkt)
let UNIT = 'mm';
try { if (localStorage.getItem('gpUnit') === 'cm') UNIT = 'cm'; } catch (e) {}
export function fmtLen(mm, unit = UNIT) {
  const v = unit === 'cm' ? mm / 10 : mm;
  const d = unit === 'cm' ? (v < 10 ? 2 : 1) : (v < 100 ? 1 : 0);
  return v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ' + unit;
}

function typeOf(name) {
  // "Support material interface" vor "Support" prüfen
  if (/interface/i.test(name)) return 'interface';
  for (const [key, , , re] of TYPES) if (re.test(name)) return key;
  return 'other';
}

export function parseGcode(text) {
  const segs = {}; // key -> {pos: number[], layerEnd: number[]}
  for (const [k] of [...TYPES, TRAVEL]) segs[k] = { pos: [], layerEnd: [] };
  let x = 0, y = 0, z = 0, e = 0, relE = false, relXYZ = false, type = 'other';
  let layer = 0, markers = false, lastExtrudeZ = -1;
  const layerZ = []; // Höhe jeder Schicht
  const closeLayer = () => {
    for (const k in segs) segs[k].layerEnd[layer] = segs[k].pos.length / 3;
    layerZ[layer] = Math.max(lastExtrudeZ, 0);
    layer++;
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 59) { // ';'
      if (line.startsWith(';TYPE:')) type = typeOf(line.slice(6).trim());
      else if (line.startsWith(';LAYER_CHANGE') || line.startsWith(';LAYER:')) {
        if (markers) closeLayer(); // die Reinigungslinie vor der ersten Schicht zählt zu Schicht 1
        markers = true;
      }
      continue;
    }
    if (c0 !== 71 && c0 !== 77) continue; // G oder M
    const code = line.split(';', 1)[0].trim();
    if (code === 'G90') { relXYZ = false; continue; }
    if (code === 'G91') { relXYZ = true; continue; }
    if (code === 'M82') { relE = false; continue; }
    if (code === 'M83') { relE = true; continue; }
    if (code.startsWith('G92')) { const m = /E(-?[\d.]+)/.exec(code); if (m) e = +m[1]; continue; }
    if (!/^G[0-3](\s|$)/.test(code)) continue;
    let nx = x, ny = y, nz = z, de = 0;
    for (const tok of code.split(/\s+/).slice(1)) {
      const v = parseFloat(tok.slice(1));
      if (isNaN(v)) continue;
      switch (tok[0]) {
        case 'X': nx = relXYZ ? x + v : v; break;
        case 'Y': ny = relXYZ ? y + v : v; break;
        case 'Z': nz = relXYZ ? z + v : v; break;
        case 'E': de = relE ? v : v - e; e = relE ? e : v; break;
      }
    }
    const moved = nx !== x || ny !== y;
    if (moved) {
      const extruding = de > 0;
      // ohne Schicht-Kommentare: neue Schicht, sobald auf größerer Höhe extrudiert wird
      if (extruding && !markers && nz > lastExtrudeZ + 1e-4 && lastExtrudeZ >= 0) closeLayer();
      if (extruding) lastExtrudeZ = nz;
      const s = segs[extruding ? type : 'travel'];
      s.pos.push(x, z, -y, nx, nz, -ny); // G-Code: Z oben → three.js: Y oben
    }
    x = nx; y = ny; z = nz;
  }
  closeLayer();
  return { segs, layers: layer, layerZ };
}

export class GcodePreview {
  constructor(host) {
    this.host = host;
    host.classList.add('gp');
    this.canvas = document.createElement('canvas');
    this.busy = Object.assign(document.createElement('div'), { className: 'gp-busy', hidden: true });
    this.msg = Object.assign(document.createElement('div'), { className: 'gp-msg' });
    this.legend = Object.assign(document.createElement('div'), { className: 'gp-legend' });
    this.sliderBox = Object.assign(document.createElement('div'), { className: 'gp-slider' });
    this.slider = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 0, value: 0 });
    this.layerLabel = Object.assign(document.createElement('div'), { className: 'gp-layer' });
    this.sliderBox.append(this.slider, this.layerLabel);
    this.help = Object.assign(document.createElement('div'), { className: 'gp-help', textContent: 'Ziehen: drehen · Rechts/Shift: verschieben · Rad: zoomen · Doppelklick: zurück' });
    // Abmessungen + Messwerkzeug
    this.labels = Object.assign(document.createElement('div'), { className: 'gp-labels' });
    this.dims = Object.assign(document.createElement('div'), { className: 'gp-dims', hidden: true });
    this.measureInfo = Object.assign(document.createElement('div'), { className: 'gp-measure', hidden: true });
    host.append(this.canvas, this.labels, this.legend, this.sliderBox, this.dims, this.busy, this.msg, this.help);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this._bed();
    this.dimGroup = new THREE.Group();
    this.measureGroup = new THREE.Group();
    this.scene.add(this.dimGroup, this.measureGroup);
    this.showDims = true;
    this.measuring = false;
    this.points = [];
    this.raycaster = new THREE.Raycaster();
    this.hidden = new Set(['travel']);
    this.view = { theta: -0.6, phi: 1.0, dist: 420, target: new THREE.Vector3(0, 0, 0) };
    this._controls();
    this.slider.addEventListener('input', () => this._applyLayer());
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(host);
    this._resize();
  }

  _bed() {
    const bed = new THREE.Group();
    const grid = new THREE.GridHelper(220, 22, 0x4b5563, 0x2a2f38);
    bed.add(grid);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(220, 220).rotateX(-Math.PI / 2)),
      new THREE.LineBasicMaterial({ color: 0xee7f00 }));
    bed.add(edge);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(220, 220).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x15181e, transparent: true, opacity: 0.85 }));
    plate.position.y = -0.05;
    bed.add(plate);
    this.scene.add(bed);
  }

  _controls() {
    let drag = null;
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button === 2 || e.shiftKey }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointerup', e => {
      // Klick ohne Ziehen im Messmodus: Messpunkt setzen
      if (drag && this.measuring && e.button === 0 && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) this._pick(e);
      drag = null;
    });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        const s = this.view.dist / 600;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        this.view.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
      } else {
        this.view.theta -= dx * 0.008;
        this.view.phi = Math.min(Math.PI - 0.05, Math.max(0.05, this.view.phi - dy * 0.008));
      }
      this._render();
    });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.view.dist = Math.min(2000, Math.max(20, this.view.dist * (1 + Math.sign(e.deltaY) * 0.1)));
      this._render();
    }, { passive: false });
    c.addEventListener('dblclick', () => { if (!this.measuring) this.fit(); });
  }

  _resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._render();
  }

  _render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      const v = this.view;
      this.camera.position.set(
        v.target.x + v.dist * Math.sin(v.phi) * Math.sin(v.theta),
        v.target.y + v.dist * Math.cos(v.phi),
        v.target.z + v.dist * Math.sin(v.phi) * Math.cos(v.theta));
      this.camera.lookAt(v.target);
      this.camera.updateMatrixWorld();
      this.renderer.render(this.scene, this.camera);
      this._placeLabels();
    });
  }

  setBusy(text) {
    this.busy.hidden = !text;
    this.busy.textContent = text || '';
  }

  setMessage(text) { this.msg.textContent = text || ''; this.msg.hidden = !text; }

  clear() {
    for (const o of [...this.group.children]) { o.geometry.dispose(); o.material.dispose(); }
    this.group.clear();
    this.data = null;
    this.legend.replaceChildren();
    this.slider.max = 0;
    this.layerLabel.textContent = '';
    this.box = null; this.partBox = null;
    this._clearGroup(this.dimGroup);
    this.dims.hidden = true;
    this._render();
  }

  _clearGroup(g) {
    for (const o of [...g.children]) { o.geometry?.dispose(); o.material?.dispose(); }
    g.clear();
  }

  async loadUrl(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error('Vorschau nicht verfügbar (HTTP ' + res.status + ')');
    this.load(await res.text());
  }

  load(text) {
    const keepLayer = this.data && +this.slider.value === +this.slider.max; // oben bleiben, falls ganz oben
    const firstLoad = !this.data;
    this.clear();
    const d = parseGcode(text);
    this.data = d;
    this.meshes = {};
    const box = new THREE.Box3(), part = new THREE.Box3();
    for (const [k, , color] of [...TYPES, TRAVEL]) {
      const s = d.segs[k];
      if (!s.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
      if (k !== 'travel') { g.computeBoundingBox(); box.union(g.boundingBox); if (!NOT_PART.has(k)) part.union(g.boundingBox); }
      const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: k === 'travel', opacity: k === 'travel' ? 0.35 : 1 }));
      m.visible = !this.hidden.has(k);
      this.group.add(m);
      this.meshes[k] = m;
    }
    this.box = box;
    this.partBox = part.isEmpty() ? box.clone() : part;
    this._legend();
    this._buildDims();
    // Messpunkte passen nach neuem Slicen meist nicht mehr
    if (!firstLoad) this.clearMeasure();
    this.slider.max = Math.max(0, d.layers - 1);
    if (firstLoad || keepLayer || +this.slider.value > +this.slider.max) this.slider.value = this.slider.max;
    this._applyLayer();
    if (firstLoad) this.fit();
    this.setMessage(d.layers ? '' : 'Keine Druckwege gefunden');
  }

  _legend() {
    const d = this.data;
    const total = TYPES.reduce((a, [k]) => a + d.segs[k].pos.length, 0) || 1;
    const items = [...TYPES, TRAVEL].filter(([k]) => d.segs[k].pos.length);
    this.legend.replaceChildren(...items.map(([k, label, color]) => {
      const row = document.createElement('label');
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !this.hidden.has(k) });
      cb.addEventListener('change', () => {
        if (cb.checked) this.hidden.delete(k); else this.hidden.add(k);
        if (this.meshes[k]) this.meshes[k].visible = cb.checked;
        this._render();
      });
      const sw = document.createElement('i'); sw.style.background = color;
      const pct = k === 'travel' ? '' : ` ${Math.round(d.segs[k].pos.length / total * 100)} %`;
      row.append(cb, sw, document.createTextNode(label + pct));
      return row;
    }));
  }

  _applyLayer() {
    if (!this.data) return;
    const L = +this.slider.value;
    for (const k in this.meshes) this.meshes[k].geometry.setDrawRange(0, (this.data.segs[k].layerEnd[L] ?? this.data.segs[k].pos.length / 3));
    const z = this.data.layerZ[L] ?? 0;
    this.layerLabel.textContent = `Schicht ${L + 1} / ${this.data.layers}` + (z ? ` · ${z.toFixed(2).replace('.', ',')} mm` : '');
    this._render();
  }

  // ------------------------------------------------ Abmessungen und Messen
  // Größe des Teils (ohne Stützen und Rand) in mm: { x: Breite, y: Tiefe, z: Höhe }
  size() {
    const b = this.partBox;
    if (!b || b.isEmpty()) return null;
    const s = b.getSize(new THREE.Vector3());
    // Höhe ab Druckbett (die erste Schicht liegt bei Schichthöhe, beginnt aber bei 0)
    return { x: s.x, y: s.z, z: b.max.y };
  }

  setUnit(u) {
    UNIT = u === 'cm' ? 'cm' : 'mm';
    try { localStorage.setItem('gpUnit', UNIT); } catch (e) {}
    this._updateDimsText(); this._updateMeasureText(); this._render();
  }

  _line(a, b, color, opts = {}) {
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const m = opts.dashed ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true, opacity: opts.opacity ?? 1 })
      : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: opts.opacity ?? 1 });
    const l = new THREE.Line(g, m);
    if (opts.dashed) l.computeLineDistances();
    l.renderOrder = 10;
    return l;
  }

  // Maßlinien am Modell: Breite vorne, Tiefe rechts, Höhe vorne rechts + Umriss
  _buildDims() {
    this._clearGroup(this.dimGroup);
    this.dimLabels = [];
    const b = this.partBox;
    if (!b || b.isEmpty()) { this.dims.hidden = true; return; }
    const x0 = b.min.x, x1 = b.max.x, z0 = b.min.z, z1 = b.max.z, h = b.max.y;
    const off = Math.max(4, Math.min(15, (x1 - x0 + z1 - z0) * 0.06));
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const col = 0x38bdf8, G = this.dimGroup;
    // Umriss (gestrichelt)
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(x1 - x0, h, z1 - z0)),
      new THREE.LineDashedMaterial({ color: col, dashSize: 2, gapSize: 2, transparent: true, opacity: 0.45, depthTest: false }));
    box.position.set((x0 + x1) / 2, h / 2, (z0 + z1) / 2); box.computeLineDistances(); box.renderOrder = 9;
    G.add(box);
    const dim = (a, b, ext1a, ext1b, ext2a, ext2b, key) => {
      G.add(this._line(a, b, col), this._line(ext1a, ext1b, col, { opacity: 0.5 }), this._line(ext2a, ext2b, col, { opacity: 0.5 }));
      this.dimLabels.push({ pos: a.clone().add(b).multiplyScalar(0.5), key });
    };
    // Breite (X) vor dem Modell
    dim(V(x0, 0, z1 + off), V(x1, 0, z1 + off), V(x0, 0, z1), V(x0, 0, z1 + off * 1.3), V(x1, 0, z1), V(x1, 0, z1 + off * 1.3), 'x');
    // Tiefe (Y) rechts neben dem Modell
    dim(V(x1 + off, 0, z0), V(x1 + off, 0, z1), V(x1, 0, z0), V(x1 + off * 1.3, 0, z0), V(x1, 0, z1), V(x1 + off * 1.3, 0, z1), 'y');
    // Höhe (Z) vorne links
    dim(V(x0 - off, 0, z1 + off), V(x0 - off, h, z1 + off), V(x0, 0, z1), V(x0 - off, 0, z1 + off), V(x0, h, z1), V(x0 - off * 1.3, h, z1 + off * 1.3), 'z');
    this.dimGroup.visible = this.showDims;
    this._updateDimsText();
  }

  _updateDimsText() {
    const s = this.size();
    if (!s) { this.dims.hidden = true; return; }
    this.dims.hidden = false;
    const mk = (tag, cls, text, on) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; if (on) e.addEventListener('click', on); return e; };
    const head = mk('div', 'gp-dims-head');
    head.append(mk('b', '', 'Größe'));
    const units = mk('div', 'gp-seg');
    for (const u of ['mm', 'cm']) { const btn = mk('button', u === UNIT ? 'on' : '', u, () => this.setUnit(u)); btn.type = 'button'; units.append(btn); }
    head.append(units);
    const rows = mk('div', 'gp-dims-rows');
    for (const [k, label] of [['x', 'Breite (X)'], ['y', 'Tiefe (Y)'], ['z', 'Höhe (Z)']]) rows.append(mk('span', '', label), mk('b', '', fmtLen(s[k])));
    const tools = mk('div', 'gp-dims-tools');
    const tDims = mk('button', this.showDims ? 'on' : '', 'Maßlinien', () => { this.showDims = !this.showDims; this.dimGroup.visible = this.showDims; this._updateDimsText(); this._render(); });
    const tMeasure = mk('button', this.measuring ? 'on' : '', '📏 Messen', () => this.setMeasuring(!this.measuring));
    tDims.type = tMeasure.type = 'button';
    tools.append(tDims, tMeasure);
    const fits = s.x <= 220 && s.y <= 220 && s.z <= 220;
    this.dims.replaceChildren(head, rows, ...(fits ? [] : [mk('div', 'gp-warn', 'Größer als das Druckbett (220 × 220 × 220 mm)')]), tools, this.measureInfo);
  }

  setMeasuring(on) {
    this.measuring = on;
    this.canvas.classList.toggle('measuring', on);
    if (!on) this.clearMeasure();
    else { this.measureInfo.hidden = false; this._updateMeasureText(); }
    this._updateDimsText();
  }

  clearMeasure() {
    this.points = [];
    this._clearGroup(this.measureGroup);
    this.measureLabel = null;
    this._updateMeasureText();
    this._render();
  }

  // Punkt unter dem Mauszeiger: nächster sichtbarer Druckweg, sonst Druckbett
  _pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Line.threshold = Math.max(0.3, this.view.dist / 400);
    const targets = Object.entries(this.meshes || {}).filter(([k, m]) => k !== 'travel' && m.visible).map(([, m]) => m);
    let p = this.raycaster.intersectObjects(targets, false)[0]?.point;
    if (!p) { // Druckbett (Höhe 0)
      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) && Math.abs(hit.x) <= 115 && Math.abs(hit.z) <= 115) p = hit;
    }
    if (!p) return;
    if (this.points.length >= 2) this.clearMeasure();
    this.points.push(p.clone());
    const dot = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.6, this.view.dist / 300), 12, 8), new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false }));
    dot.position.copy(p); dot.renderOrder = 11;
    this.measureGroup.add(dot);
    if (this.points.length === 2) {
      const [a, b] = this.points;
      this.measureGroup.add(this._line(a, b, 0xfacc15));
      this.measureLabel = a.clone().add(b).multiplyScalar(0.5);
    }
    this._updateMeasureText();
    this._render();
  }

  _measureValues() {
    if (this.points.length < 2) return null;
    const [a, b] = this.points;
    return { d: a.distanceTo(b), dx: Math.abs(b.x - a.x), dy: Math.abs(b.z - a.z), dz: Math.abs(b.y - a.y) };
  }

  _updateMeasureText() {
    const box = this.measureInfo;
    if (!this.measuring) { box.hidden = true; return; }
    box.hidden = false;
    const m = this._measureValues();
    if (!m) {
      box.textContent = this.points.length ? 'Zweiten Punkt anklicken …' : 'Messen: zwei Punkte am Modell oder auf dem Druckbett anklicken';
      return;
    }
    box.replaceChildren();
    const b = document.createElement('b'); b.textContent = 'Abstand ' + fmtLen(m.d);
    const s = document.createElement('span'); s.textContent = `X ${fmtLen(m.dx)} · Y ${fmtLen(m.dy)} · Z ${fmtLen(m.dz)}`;
    const again = document.createElement('button'); again.type = 'button'; again.textContent = 'Neu messen'; again.addEventListener('click', () => this.clearMeasure());
    box.append(b, s, again);
  }

  // Beschriftungen der Maßlinien (HTML über dem Bild, an die 3D-Position projiziert)
  _placeLabels() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, s = this.size();
    const items = [];
    if (this.showDims && s && this.dimLabels) for (const l of this.dimLabels) items.push([l.pos, fmtLen(s[l.key]), 'dim']);
    const m = this._measureValues();
    if (m && this.measureLabel) items.push([this.measureLabel, fmtLen(m.d), 'meas']);
    while (this.labels.children.length < items.length) this.labels.append(document.createElement('span'));
    [...this.labels.children].forEach((span, i) => {
      const it = items[i];
      if (!it) { span.hidden = true; return; }
      const v = it[0].clone().project(this.camera);
      span.hidden = v.z > 1;
      span.className = it[2];
      span.textContent = it[1];
      span.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * h}px) translate(-50%, -50%)`;
    });
  }

  // Kamera auf das Modell (bzw. das Druckbett) ausrichten
  fit() {
    const b = this.box && !this.box.isEmpty() ? this.box : new THREE.Box3(new THREE.Vector3(-110, 0, -110), new THREE.Vector3(110, 20, 110));
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    const r = Math.max(35, size.length() * 0.55);
    this.view = { theta: -0.6, phi: 1.0, dist: r / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)), target: c };
    this._render();
  }

  dispose() {
    this.ro.disconnect();
    this.clear();
    this.renderer.dispose();
  }
}
