// 3D-Modellansicht: lädt das gewählte Modell und dreht es langsam auf einem Drehteller.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';


export class ModelViewer {
  constructor(canvas, { color = '#ff7a00', speed = 0.35, width = 664, height = 888 } = {}) {
    this.color = new THREE.Color(color);
    this.speed = speed;
    this.W = width; this.H = height;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setSize(width, height, false);
    this.renderer.localClippingEnabled = true;

    // Druckfortschritt: unterhalb der Ebene farbig, oberhalb durchsichtig
    this.clipBelow = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    this.clipAbove = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1e6);
    this.progress = null; this.shownProgress = null; this.topY = 0;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 5000);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(120, 260, 180);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 1, far: 800 });
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xff8a20, 1.6);
    rim.position.set(-200, 120, -220);
    this.scene.add(rim);

    this.turntable = new THREE.Group();
    this.scene.add(this.turntable);
    this.clock = new THREE.Clock();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  setPixelScale(s) {
    this.renderer.setPixelRatio(Math.min(3, (window.devicePixelRatio || 1) * s));
    this.renderer.setSize(this.W, this.H, false);
  }

  // f: 0..1 oder null (= komplettes Modell zeigen)
  setProgress(f) {
    this.progress = f == null || isNaN(f) ? null : Math.max(0, Math.min(1, f));
  }

  setColor(c) {
    this.color.set(c);
  }

  _applyProgress(dt) {
    if (this.progress == null) {
      this.shownProgress = null;
      this.clipBelow.constant = 1e6; this.clipAbove.constant = -1e6;
      if (this.ring) this.ring.visible = false;
      return;
    }
    if (this.shownProgress == null) this.shownProgress = 0;
    this.shownProgress += (this.progress - this.shownProgress) * Math.min(1, dt * 2.5); // sanft nachführen
    const y = this.shownProgress * this.topY;
    this.clipBelow.constant = y;
    this.clipAbove.constant = -y;
    if (this.ring) {
      this.ring.visible = this.shownProgress < 0.999;
      this.ring.position.y = y;
      this.ring.material.opacity = 0.55 + 0.3 * Math.sin(performance.now() / 300);
    }
  }

  clear() {
    this.turntable.traverse(o => { o.geometry?.dispose?.(); });
    this.turntable.clear();
  }

  // Lädt /api/model. Gibt {name, size:[x,y,z]} zurück oder null, wenn kein Modell gewählt ist.
  async load(url = 'api/model') {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) { this.clear(); return null; }
    if (!res.ok) throw new Error('Modell konnte nicht geladen werden (HTTP ' + res.status + ')');
    const name = decodeURIComponent(res.headers.get('X-Model-Name') || 'modell.stl');
    const buf = await res.arrayBuffer();
    const object = await this.parse(name, buf);
    return { name, ...this.show(object) };
  }

  async parse(name, buf) {
    const ext = name.toLowerCase().split('.').pop();
    const zUp = new THREE.Group();
    zUp.rotation.x = -Math.PI / 2; // Druckdateien sind Z-oben, three.js ist Y-oben
    switch (ext) {
      case 'gx': // FlashPrint: G-Code hinter einem Binärkopf
        return this._gcode(new TextDecoder().decode(buf));
      case 'stl': {
        const geo = new STLLoader().parse(buf);
        geo.deleteAttribute('color');
        geo.deleteAttribute('normal'); // Normalen in STL-Dateien sind oft leer oder falsch
        geo.computeVertexNormals();
        zUp.add(this._mesh(geo));
        return zUp;
      }
      case 'obj': {
        const obj = new OBJLoader().parse(new TextDecoder().decode(buf));
        obj.traverse(o => {
          if (!o.isMesh) return;
          o.geometry.deleteAttribute('normal'); o.geometry.computeVertexNormals();
          o.material = this._material(); o.castShadow = true;
          o.add(this._ghost(o.geometry));
        });
        zUp.add(obj);
        return zUp;
      }
      case '3mf': {
        const r = parse3MF(buf);
        if (r.positions) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
          geo.computeVertexNormals();
          zUp.add(this._mesh(geo));
          return zUp;
        }
        if (r.gcode) return this._gcode(r.gcode);
        throw new Error('In der 3MF-Datei wurden keine Modelldaten gefunden');
      }
      case 'glb': case 'gltf': {
        const gltf = await new Promise((ok, fail) => new GLTFLoader().parse(buf, '', ok, fail));
        const meshes = [];
        gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
        for (const o of meshes) { o.material = this._material(); o.castShadow = true; o.add(this._ghost(o.geometry)); }
        return gltf.scene; // glTF ist bereits Y-oben
      }
      case 'gcode': case 'gco': case 'g':
        return this._gcode(new TextDecoder().decode(buf));
    }
    throw new Error('Dateityp .' + ext + ' wird nicht unterstützt');
  }

  _material() {
    return new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.42, metalness: 0.05, side: THREE.DoubleSide,
      shadowSide: THREE.FrontSide, clippingPlanes: [this.clipBelow], clipShadows: true });
  }

  // noch nicht gedruckter Teil: halbdurchsichtig
  _ghost(geo) {
    const g = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc9ced8, roughness: 0.6, transparent: true,
      opacity: 0.13, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: [this.clipAbove] }));
    g.renderOrder = 2;
    return g;
  }

  _mesh(geo) {
    const m = new THREE.Mesh(geo, this._material());
    m.castShadow = true;
    m.add(this._ghost(geo));
    return m;
  }

  _gcode(text) {
    const positions = parseGCode(text);
    if (!positions.length) throw new Error('Im G-Code wurden keine Druckbewegungen gefunden');
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // nach Höhe leicht abdunkeln/aufhellen, damit die Schichten erkennbar sind
    geo.computeBoundingBox();
    const { min, max } = geo.boundingBox, colors = new Float32Array(positions.length);
    const c = new THREE.Color();
    for (let i = 0; i < positions.length; i += 3) {
      const t = (positions[i + 2] - min.z) / ((max.z - min.z) || 1);
      c.copy(this.color).multiplyScalar(0.55 + 0.6 * t);
      colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const zUp = new THREE.Group();
    zUp.rotation.x = -Math.PI / 2;
    zUp.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, clippingPlanes: [this.clipBelow] })));
    zUp.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xc9ced8, transparent: true, opacity: 0.12,
      depthWrite: false, clippingPlanes: [this.clipAbove] })));
    return zUp;
  }

  // Modell auf den Drehteller stellen, zentrieren und Kamera passend ausrichten.
  show(object) {
    this.clear();
    const holder = new THREE.Group();
    holder.add(object);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object, true);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    object.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));

    // auf eine einheitliche Größe bringen (Maße bleiben für die Anzeige erhalten)
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 120 / maxDim;
    holder.scale.setScalar(scale);
    this.turntable.add(holder);

    // Druckplatte
    const footprint = Math.max(size.x, size.z) * scale;
    const plateR = Math.max(footprint * 0.5 * 1.25, 45);
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(plateR, plateR, 3, 96),
      new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.8, metalness: 0.2 }));
    plate.position.y = -1.6;
    plate.receiveShadow = true;
    this.turntable.add(plate);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(plateR, 0.9, 8, 128),
      new THREE.MeshBasicMaterial({ color: 0xff7a00 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.1;
    this.turntable.add(ring);
    const grid = new THREE.PolarGridHelper(plateR * 0.96, 12, 5, 96, 0x3a3f48, 0x2a2e35);
    grid.position.y = 0.05;
    this.turntable.add(grid);

    // Kamera einpassen: Modell + Druckplatte müssen sich in jeder Drehstellung mit Rand
    // im Bild befinden; oben bleibt Platz für die Beschriftung.
    const h = size.y * scale;
    const elev = THREE.MathUtils.degToRad(24);
    const dir = new THREE.Vector3(0, Math.sin(elev), Math.cos(elev));
    const target = new THREE.Vector3(0, h * 0.45, 0);
    const pts = [];
    for (let k = 0; k < 24; k++) {
      const a = k / 24 * Math.PI * 2;
      for (const y of [-3, h]) pts.push(new THREE.Vector3(Math.cos(a) * plateR, y, Math.sin(a) * plateR));
    }
    let dist = Math.max(plateR, h) * 3;
    const v = new THREE.Vector3();
    for (let iter = 0; iter < 12; iter++) {
      this.camera.position.copy(target).addScaledVector(dir, dist);
      this.camera.lookAt(target);
      this.camera.near = dist / 50; this.camera.far = dist * 10;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      let worst = 0, ymin = 1, ymax = -1;
      for (const p of pts) {
        v.copy(p).project(this.camera);
        ymin = Math.min(ymin, v.y); ymax = Math.max(ymax, v.y);
        worst = Math.max(worst, Math.abs(v.x) / 0.86, v.y > 0 ? v.y / 0.66 : -v.y / 0.86);
      }
      // senkrecht mittig in den erlaubten Bereich [-0.86, 0.66] schieben
      const shift = ((ymin + ymax) / 2 - (-0.86 + 0.66) / 2) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * dist;
      target.y += shift * 0.8;
      dist *= Math.min(1.5, Math.max(0.6, worst));
    }
    this.turntable.rotation.y = -0.6;

    // Leuchtring auf aktueller Druckhöhe
    this.topY = h;
    if (this.ring) { this.scene.remove(this.ring); this.ring.geometry.dispose(); }
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(footprint * 0.5 * 1.08 + 2, 0.7, 8, 128),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.8 }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.scene.add(this.ring);
    this.shownProgress = null;

    // Anzeige: Breite × Tiefe × Höhe in Datei-Einheiten (i. d. R. mm)
    return { size: [size.x, size.z, size.y] };
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    if (this.paused) return; // z. B. Reiter auf der Webseite nicht sichtbar
    // auf ~30 Bilder/s begrenzen: reicht für eine langsame Drehung und schont schwache PCs
    if (now - (this._last || 0) < 31) return;
    this._last = now;
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.turntable.rotation.y += dt * this.speed;
    this._applyProgress(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

// ---------- 3MF ----------
// Eigener, kleiner Parser: unterstützt auch Bauteile in Unterdateien (Bambu Studio,
// OrcaSlicer, PrusaSlicer). Liefert alle Dreiecke in Druckbett-Koordinaten.
// Ist kein Modell enthalten (z. B. ".gcode.3mf"), wird der G-Code zurückgegeben.
export function parse3MF(buf) {
  const zip = unzipSync(new Uint8Array(buf));
  const files = {};
  for (const k in zip) files['/' + k.replace(/^\/+/, '').toLowerCase()] = zip[k];

  let root = '/3d/3dmodel.model';
  const rels = files['/_rels/.rels'];
  if (rels) {
    const doc = new DOMParser().parseFromString(strFromU8(rels), 'application/xml');
    for (const r of doc.getElementsByTagName('Relationship')) {
      if (/3dmodel$/i.test(r.getAttribute('Type') || '')) root = '/' + r.getAttribute('Target').replace(/^\/+/, '').toLowerCase();
    }
  }

  const docs = {};
  const getDoc = p => {
    p = p.toLowerCase();
    if (!(p in docs)) docs[p] = files[p] ? new DOMParser().parseFromString(strFromU8(files[p]), 'application/xml') : null;
    return docs[p];
  };
  const objCache = {};
  const getObject = (path, id) => {
    const key = path + '#' + id;
    if (key in objCache) return objCache[key];
    let found = null;
    const doc = getDoc(path);
    if (doc) for (const o of doc.getElementsByTagNameNS('*', 'object')) if (o.getAttribute('id') === id) { found = o; break; }
    return (objCache[key] = found);
  };
  const attr = (el, local) => {
    for (const a of el.attributes) if (a.localName === local) return a.value;
    return null;
  };
  const matrix = t => {
    const m = new THREE.Matrix4();
    if (!t) return m;
    const v = t.trim().split(/\s+/).map(Number);
    if (v.length !== 12) return m;
    m.set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
    return m;
  };

  const chunks = [];
  let total = 0;
  const p = new THREE.Vector3();
  const emit = (path, id, world, depth) => {
    if (depth > 16) return;
    const obj = getObject(path, id);
    if (!obj) return;
    const mesh = obj.getElementsByTagNameNS('*', 'mesh')[0];
    if (mesh) {
      const vs = mesh.getElementsByTagNameNS('*', 'vertex');
      const verts = new Float32Array(vs.length * 3);
      for (let i = 0; i < vs.length; i++) {
        p.set(+vs[i].getAttribute('x'), +vs[i].getAttribute('y'), +vs[i].getAttribute('z')).applyMatrix4(world);
        verts[i * 3] = p.x; verts[i * 3 + 1] = p.y; verts[i * 3 + 2] = p.z;
      }
      const ts = mesh.getElementsByTagNameNS('*', 'triangle');
      const out = new Float32Array(ts.length * 9);
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        const idx = [+t.getAttribute('v1'), +t.getAttribute('v2'), +t.getAttribute('v3')];
        for (let k = 0; k < 3; k++) {
          const j = idx[k] * 3;
          out[i * 9 + k * 3] = verts[j]; out[i * 9 + k * 3 + 1] = verts[j + 1]; out[i * 9 + k * 3 + 2] = verts[j + 2];
        }
      }
      chunks.push(out); total += out.length;
    }
    for (const c of obj.getElementsByTagNameNS('*', 'component')) {
      const sub = attr(c, 'path');
      const subPath = sub ? '/' + sub.replace(/^\/+/, '').toLowerCase() : path;
      emit(subPath, c.getAttribute('objectid'), world.clone().multiply(matrix(c.getAttribute('transform'))), depth + 1);
    }
  };

  const rootDoc = getDoc(root);
  if (rootDoc) {
    for (const item of rootDoc.getElementsByTagNameNS('*', 'item')) {
      if (attr(item, 'printable') === '0') continue;
      const sub = attr(item, 'path');
      const path = sub ? '/' + sub.replace(/^\/+/, '').toLowerCase() : root;
      emit(path, item.getAttribute('objectid'), matrix(item.getAttribute('transform')), 0);
    }
  }

  if (total > 0) {
    const positions = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { positions.set(c, o); o += c.length; }
    return { positions };
  }
  const g = Object.keys(files).filter(k => k.endsWith('.gcode')).sort()[0];
  if (g) return { gcode: strFromU8(files[g]) };
  return {};
}

// ---------- G-Code ----------
// Liefert Liniensegmente (x,y,z Paare) aller Bewegungen, bei denen extrudiert wird.
// Unterstützt G90/G91, M82/M83, G92 sowie Kreisbögen G2/G3 (I/J).
export function parseGCode(text) {
  const out = [];
  let x = 0, y = 0, z = 0, e = 0, absXYZ = true, absE = true;
  const push = (x1, y1, z1, x2, y2, z2) => out.push(x1, y1, z1, x2, y2, z2);
  for (const raw of text.split('\n')) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[0].toUpperCase();
    const a = {};
    for (let i = 1; i < parts.length; i++) {
      const k = parts[i][0]?.toUpperCase(), v = parseFloat(parts[i].slice(1));
      if (k && !isNaN(v)) a[k] = v;
    }
    switch (cmd) {
      case 'G90': absXYZ = true; absE = true; break;
      case 'G91': absXYZ = false; absE = false; break;
      case 'M82': absE = true; break;
      case 'M83': absE = false; break;
      case 'G92':
        if ('X' in a) x = a.X; if ('Y' in a) y = a.Y; if ('Z' in a) z = a.Z; if ('E' in a) e = a.E;
        break;
      case 'G0': case 'G1': case 'G00': case 'G01': case 'G2': case 'G3': case 'G02': case 'G03': {
        const nx = 'X' in a ? (absXYZ ? a.X : x + a.X) : x;
        const ny = 'Y' in a ? (absXYZ ? a.Y : y + a.Y) : y;
        const nz = 'Z' in a ? (absXYZ ? a.Z : z + a.Z) : z;
        let de = 0;
        if ('E' in a) { de = absE ? a.E - e : a.E; e = absE ? a.E : e + a.E; }
        const extrude = de > 0 && (nx !== x || ny !== y);
        if (extrude) {
          if (cmd === 'G2' || cmd === 'G3' || cmd === 'G02' || cmd === 'G03') {
            const cx = x + (a.I || 0), cy = y + (a.J || 0), r = Math.hypot(x - cx, y - cy);
            let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
            const cw = cmd === 'G2' || cmd === 'G02';
            if (cw && a1 >= a0) a1 -= 2 * Math.PI;
            if (!cw && a1 <= a0) a1 += 2 * Math.PI;
            const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / 1.5));
            let px = x, py = y, pz = z;
            for (let i = 1; i <= steps; i++) {
              const t = i / steps, ang = a0 + (a1 - a0) * t;
              const qx = i === steps ? nx : cx + r * Math.cos(ang), qy = i === steps ? ny : cy + r * Math.sin(ang), qz = z + (nz - z) * t;
              push(px, py, pz, qx, qy, qz); px = qx; py = qy; pz = qz;
            }
          } else push(x, y, z, nx, ny, nz);
        }
        x = nx; y = ny; z = nz;
        break;
      }
    }
  }
  return dropPurgeLines(out);
}

// Reinigungslinien (Purge/Prime) am Bettrand in der ersten Schicht entfernen,
// damit das Modell richtig zentriert wird und die Maße stimmen.
function dropPurgeLines(seg) {
  if (!seg.length) return new Float32Array(0);
  let zmin = Infinity;
  for (let i = 2; i < seg.length; i += 3) zmin = Math.min(zmin, seg[i]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < seg.length; i += 3) {
    if (seg[i + 2] > zmin + 0.6) {
      x0 = Math.min(x0, seg[i]); x1 = Math.max(x1, seg[i]);
      y0 = Math.min(y0, seg[i + 1]); y1 = Math.max(y1, seg[i + 1]);
    }
  }
  if (x0 === Infinity) return new Float32Array(seg); // nur eine Schicht -> nichts filtern
  const m = 10, inside = (x, y) => x > x0 - m && x < x1 + m && y > y0 - m && y < y1 + m;
  const out = [];
  for (let i = 0; i < seg.length; i += 6) {
    const low = seg[i + 2] <= zmin + 0.6;
    if (low && !inside(seg[i], seg[i + 1]) && !inside(seg[i + 3], seg[i + 4])) continue;
    for (let k = 0; k < 6; k++) out.push(seg[i + k]);
  }
  return new Float32Array(out);
}
