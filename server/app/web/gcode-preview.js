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
    host.append(this.canvas, this.legend, this.sliderBox, this.busy, this.msg, this.help);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this._bed();
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
    c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointerup', () => { drag = null; });
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
    c.addEventListener('dblclick', () => this.fit());
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
      this.renderer.render(this.scene, this.camera);
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
    this._render();
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
    const box = new THREE.Box3();
    for (const [k, , color] of [...TYPES, TRAVEL]) {
      const s = d.segs[k];
      if (!s.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
      if (k !== 'travel') { g.computeBoundingBox(); box.union(g.boundingBox); }
      const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: k === 'travel', opacity: k === 'travel' ? 0.35 : 1 }));
      m.visible = !this.hidden.has(k);
      this.group.add(m);
      this.meshes[k] = m;
    }
    this.box = box;
    this._legend();
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
