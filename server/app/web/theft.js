// Reiter "Diebstahlschutz": Karte mit den Standorten der Handys, Geofence (Mittelpunkt + Radius) einstellen,
// Geräte sperren/entsperren/testen. Nutzt Leaflet (OpenStreetMap). Braucht $, el, api, json, toast, confirmDlg.
"use strict";

const TF = { built: false, visible: false, timer: null, map: null, markers: new Map(), circle: null, centerMarker: null,
  track: null, data: null, cfg: null, pickCenter: false, selected: null, tileOk: true };

function showTheft(on) {
  TF.visible = on;
  clearTimeout(TF.timer);
  if (!on) return;
  if (!TF.built) tfBuild();
  tfLoad();
}

function tfBuild() {
  const page = $("[data-page=theft]");
  TF.mapEl = el("div", { class: "tf-map", id: "tfMap" });
  TF.sidebar = el("div", { class: "tf-side" });
  page.replaceChildren(
    el("div", { class: "row" }, el("div", {}, el("h2", {}, "Diebstahlschutz"),
      el("p", { class: "sub" }, "Standorte der Handys auf der Karte. Verlässt ein Gerät den eingestellten Bereich dauerhaft, löst es Alarm aus und sperrt sich – du wirst benachrichtigt und kannst es hier wieder entsperren."))),
    el("div", { class: "tf-layout" }, el("div", { class: "tf-mapwrap panel" }, TF.mapEl), TF.sidebar));
  TF.built = true;
  setTimeout(tfInitMap, 50);
}

function tfInitMap() {
  if (typeof L === "undefined") { TF.mapEl.replaceChildren(el("p", { class: "muted", style: "padding:20px" }, "Karte konnte nicht geladen werden (keine Internetverbindung zu OpenStreetMap?).")); return; }
  TF.map = L.map(TF.mapEl, { zoomControl: true }).setView([51.1, 10.4], 6);
  TF.tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap" });
  TF.tiles.on("tileerror", () => { if (TF.tileOk) { TF.tileOk = false; toast("Kartenkacheln nicht erreichbar – Standorte werden trotzdem angezeigt."); } });
  TF.tiles.addTo(TF.map);
  TF.map.on("click", e => { if (TF.pickCenter) tfSetCenter(e.latlng.lat, e.latlng.lng); });
  if (TF.data) tfRenderMap();
}

async function tfLoad() {
  try { TF.data = await api("/api/admin/theft"); }
  catch (e) { TF.sidebar.replaceChildren(el("p", { class: "muted" }, e.message)); return; }
  // Konfiguration nur beim ersten Laden vom Server \u00fcbernehmen – sonst w\u00fcrde das 8-Sekunden-Polling
  // laufende, noch nicht gespeicherte Eingaben (Mittelpunkt, Radius \u2026) \u00fcberschreiben.
  if (!TF.cfg) TF.cfg = { ...TF.data.config };
  tfBuildSidebar();
  tfRenderCfg();
  tfRenderList();
  tfRenderMap();
  clearTimeout(TF.timer);
  if (TF.visible) TF.timer = setTimeout(tfLoad, 8000);
}

const tfStatus = d => d.locked ? { t: "Gesperrt", c: "bad" } : d.inside === 0 ? { t: "Außerhalb", c: "warn" }
  : d.inside === 1 ? { t: "Im Bereich", c: "ok" } : { t: d.lat ? "Standort unklar" : "Kein Standort", c: "idle" };
const tfAgo = t => { if (!t) return "noch nie"; const s = Date.now() / 1000 - t; if (s < 90) return "gerade eben"; if (s < 3600) return Math.round(s / 60) + " Min."; if (s < 86400) return Math.round(s / 3600) + " Std."; return Math.round(s / 86400) + " Tg."; };

function tfRenderMap() {
  if (!TF.map || !TF.data) return;
  const c = TF.cfg;
  // Geofence-Kreis + Mittelpunkt
  if (TF.circle) { TF.circle.remove(); TF.circle = null; }
  if (TF.centerMarker) { TF.centerMarker.remove(); TF.centerMarker = null; }
  if (c.lat != null && c.lon != null) {
    TF.circle = L.circle([c.lat, c.lon], { radius: c.radius_m, color: "#ee7f00", weight: 2, fillColor: "#ee7f00", fillOpacity: 0.08 }).addTo(TF.map);
    TF.centerMarker = L.marker([c.lat, c.lon], { title: "Mittelpunkt (Laden)",
      icon: L.divIcon({ className: "tf-center", html: "🏬", iconSize: [26, 26] }) }).addTo(TF.map);
  }
  // Geräte-Marker
  const seen = new Set();
  const pts = [];
  for (const d of TF.data.devices) {
    if (d.lat == null || d.lon == null) continue;
    seen.add(d.id); pts.push([d.lat, d.lon]);
    const st = tfStatus(d);
    const color = st.c === "bad" ? "#e5484d" : st.c === "warn" ? "#f5a524" : st.c === "ok" ? "#22c55e" : "#94a3b8";
    let m = TF.markers.get(d.id);
    const html = `<div class="tf-pin" style="background:${color}">${d.locked ? "🔒" : "📱"}</div>`;
    const icon = L.divIcon({ className: "tf-pinwrap", html, iconSize: [30, 30], iconAnchor: [15, 15] });
    if (!m) { m = L.marker([d.lat, d.lon], { icon }).addTo(TF.map); TF.markers.set(d.id, m); }
    else { m.setLatLng([d.lat, d.lon]); m.setIcon(icon); }
    m.bindPopup(tfPopup(d));
    m.off("click").on("click", () => { TF.selected = d.id; });
  }
  for (const [id, m] of TF.markers) if (!seen.has(id)) { m.remove(); TF.markers.delete(id); }
  // Beim ersten Mal passend zoomen
  if (!TF.fitted) {
    const all = [...pts]; if (c.lat != null) all.push([c.lat, c.lon]);
    if (all.length) { TF.map.fitBounds(all, { padding: [50, 50], maxZoom: 16 }); TF.fitted = true; }
  }
}

function tfPopup(d) {
  const st = tfStatus(d);
  return `<b>${d.name}</b><br><span style="color:#888">${st.t}${d.distance_m != null ? " · " + Math.round(d.distance_m) + " m vom Laden" : ""}</span><br>`
    + `Akku ${d.battery ?? "–"}%${d.acc ? " · ±" + Math.round(d.acc) + " m" : ""} · zuletzt ${tfAgo(d.last_at)}`
    + ((d.imei || d.serial) ? `<br><span style="font-family:monospace;font-size:11px;color:#888">${[d.imei ? "IMEI " + d.imei : "", d.serial ? "SN " + d.serial : ""].filter(Boolean).join(" · ")}</span>` : "");
}

function tfBuildSidebar() {
  if (TF.cfgPanel) return;
  TF.cfgPanel = el("div", { class: "panel tf-cfg" });
  TF.listPanel = el("div", { class: "panel tf-list" });
  TF.sidebar.replaceChildren(TF.cfgPanel, TF.listPanel);
}

function tfRenderCfg() {
  const c = TF.cfg;
  const en = el("input", { type: "checkbox", checked: c.enabled, onchange: e => { c.enabled = e.target.checked; } });
  const radius = el("input", { type: "number", min: 25, max: 100000, step: 25, value: c.radius_m, style: "width:110px",
    onchange: e => { c.radius_m = +e.target.value || 150; tfRenderMap(); }, oninput: e => { c.radius_m = +e.target.value || 150; tfRenderMap(); } });
  const autoLock = el("input", { type: "checkbox", checked: c.auto_lock, onchange: e => c.auto_lock = e.target.checked });
  const pickBtn = el("button", { class: "btn small" + (TF.pickCenter ? " primary" : ""), onclick: () => {
    TF.pickCenter = !TF.pickCenter; TF.mapEl.style.cursor = TF.pickCenter ? "crosshair" : "";
    toast(TF.pickCenter ? "Auf die Karte klicken, um den Mittelpunkt zu setzen" : ""); tfRenderCfg();
  } }, TF.pickCenter ? "Klicke auf die Karte \u2026" : "\ud83d\udccd Mittelpunkt auf Karte w\u00e4hlen");
  const addr = el("input", { type: "text", placeholder: "Adresse suchen (Stra\u00dfe, Ort) \u2026", class: "tf-addr",
    onkeydown: e => { if (e.key === "Enter") tfGeocode(addr.value); } });
  // Koordinaten direkt eingeben (genauer als Kartenklick)
  const lat = el("input", { type: "number", step: "0.000001", placeholder: "Breite (lat)", value: c.lat != null ? c.lat : "", style: "width:48%",
    onchange: e => tfSetCoord(e.target.value, null) });
  const lon = el("input", { type: "number", step: "0.000001", placeholder: "L\u00e4nge (lon)", value: c.lon != null ? c.lon : "", style: "width:48%",
    onchange: e => tfSetCoord(null, e.target.value) });
  // erweiterte Fehlalarm-Einstellungen
  const minAcc = el("input", { type: "number", min: 10, max: 500, value: c.min_accuracy_m, style: "width:70px", onchange: e => c.min_accuracy_m = +e.target.value });
  const dwell = el("input", { type: "number", min: 15, max: 3600, value: c.dwell_s, style: "width:70px", onchange: e => c.dwell_s = +e.target.value });
  const grace = el("input", { type: "number", min: 0, max: 3600, value: c.arm_grace_s, style: "width:70px", onchange: e => c.arm_grace_s = +e.target.value });
  const report = el("input", { type: "number", min: 30, max: 3600, value: c.report_interval_s, style: "width:70px", onchange: e => c.report_interval_s = +e.target.value });

  TF.cfgPanel.replaceChildren(
    el("h3", {}, "\u00dcberwachter Bereich (Geofence)"),
    el("label", { class: "chip" }, en, "Diebstahlschutz aktiv"),
    el("div", { class: "tf-center-row" }, pickBtn,
      c.lat != null ? el("small", { class: "muted" }, `Mittelpunkt: ${(+c.lat).toFixed(5)}, ${(+c.lon).toFixed(5)}`) : el("small", { class: "muted" }, "noch kein Mittelpunkt")),
    addr,
    el("label", { style: "margin-top:8px" }, "oder Koordinaten eingeben"),
    el("div", { class: "row", style: "gap:6px" }, lat, lon),
    el("label", {}, "Erlaubter Umkreis"), el("div", { class: "row" }, radius, el("span", {}, "Meter")),
    el("label", { class: "chip" }, autoLock, "Bei Diebstahl automatisch sperren"),
    el("details", { class: "tf-adv" }, el("summary", {}, "Fehlalarm-Schutz (erweitert)"),
      el("div", { class: "tf-adv-grid" },
        el("label", {}, "Nur GPS genauer als", minAcc, "m"),
        el("label", {}, "Drau\u00dfen mind.", dwell, "Sek. bis Alarm"),
        el("label", {}, "Schonzeit nach Start", grace, "Sek."),
        el("label", {}, "Standort melden alle", report, "Sek.")),
      el("p", { class: "muted", style: "font-size:12px;margin:8px 0 0" }, "Diese Werte verhindern Fehlalarme: ungenaue Messungen werden ignoriert, und das Ger\u00e4t muss den Bereich wirklich eine Weile verlassen haben.")),
    el("button", { class: "btn primary block", onclick: tfSaveCfg }, "Speichern"),
    el("p", { class: "muted", style: "font-size:12px" }, "Die Handys brauchen die Demo-App ab Version 1.14 und die Standort-Berechtigung \u201eImmer zulassen\u201c."));
}

function tfRenderList() {
  const d = TF.data;
  const online = d.devices.filter(x => x.online).length;
  const withLoc = d.devices.filter(x => x.lat != null).length;
  const locked = d.devices.filter(x => x.locked).length;
  TF.listPanel.replaceChildren(
    el("div", { class: "tf-sum" }, `${d.devices.length} Handys \u00b7 ${online} online \u00b7 ${withLoc} mit Standort` + (locked ? ` \u00b7 ${locked} gesperrt` : "")),
    ...(d.devices.length ? d.devices.map(tfDeviceRow) : [el("p", { class: "muted" }, "Noch keine Handys. Sie erscheinen, sobald die Demo-App l\u00e4uft und den Standort meldet.")]));
}

function tfDeviceRow(d) {
  const st = tfStatus(d);
  const act = [];
  if (d.lat != null) act.push(el("button", { class: "btn small", onclick: () => tfShowTrack(d) }, "Spur"));
  if (!d.locked) act.push(el("button", { class: "btn small", title: "Testalarm (endet nach 2 Min. von selbst)", onclick: () => tfTest(d) }, "🔔 Test"));
  act.push(d.locked
    ? el("button", { class: "btn small primary", onclick: () => tfLock(d, false) }, "🔓 Entsperren")
    : el("button", { class: "btn small danger", onclick: () => tfLock(d, true) }, "🔒 Sperren"));
  return el("div", { class: "tf-dev" + (d.locked ? " locked" : ""), onclick: e => { if (e.target.tagName !== "BUTTON" && d.lat != null) { TF.map.setView([d.lat, d.lon], 16); TF.markers.get(d.id)?.openPopup(); } } },
    el("div", { class: "tf-dev-top" },
      el("span", { class: `dk-state ${st.c}` }, el("i"), el("span", {}, st.t)),
      el("b", { class: "tf-dev-name" }, d.name),
      el("span", { class: "spacer" }),
      el("small", { class: "muted" }, `${d.battery ?? "–"}%`)),
    d.lock_reason && d.locked ? el("div", { class: "tf-reason" }, d.lock_reason) : null,
    el("div", { class: "tf-dev-meta muted" }, (d.distance_m != null ? `${Math.round(d.distance_m)} m vom Laden · ` : "") + (d.online ? "online" : "offline") + ` · Standort ${tfAgo(d.last_at)}`),
    el("div", { class: "tf-dev-act" }, ...act));
}

function tfSetCenter(lat, lon) {
  TF.cfg.lat = lat; TF.cfg.lon = lon;
  TF.pickCenter = false; TF.mapEl.style.cursor = "";
  tfRenderMap(); tfRenderCfg();
  toast("Mittelpunkt gesetzt \u2013 nicht vergessen zu speichern");
}

// Koordinaten-Eingabefelder: einzelne Achse setzen, Wertebereich pr\u00fcfen
function tfSetCoord(latStr, lonStr) {
  if (latStr !== null && latStr !== "") {
    const v = parseFloat(latStr);
    if (isNaN(v) || v < -90 || v > 90) { toast("Breite (lat) muss zwischen -90 und 90 liegen"); return; }
    TF.cfg.lat = v;
  }
  if (lonStr !== null && lonStr !== "") {
    const v = parseFloat(lonStr);
    if (isNaN(v) || v < -180 || v > 180) { toast("L\u00e4nge (lon) muss zwischen -180 und 180 liegen"); return; }
    TF.cfg.lon = v;
  }
  tfRenderMap(); tfRenderCfg();
  if (TF.cfg.lat != null && TF.cfg.lon != null) TF.map && TF.map.setView([TF.cfg.lat, TF.cfg.lon], Math.max(TF.map.getZoom(), 15));
}

async function tfGeocode(q) {
  if (!q.trim()) return;
  try {
    const res = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q), { headers: { "Accept-Language": "de" } });
    const r = (await res.json())[0];
    if (!r) { toast("Adresse nicht gefunden"); return; }
    tfSetCenter(+r.lat, +r.lon); TF.map.setView([+r.lat, +r.lon], 16);
  } catch (e) { toast("Adresssuche nicht möglich (keine Internetverbindung?)"); }
}

async function tfSaveCfg() {
  const c = TF.cfg;
  if (c.enabled && (c.lat == null || c.lon == null)) { toast("Bitte zuerst einen Mittelpunkt w\u00e4hlen (Karte, Adresse oder Koordinaten)"); return; }
  try {
    const saved = await api("/api/admin/theft/config", json("PUT", c));
    TF.cfg = { ...saved };            // normalisierte Werte vom Server \u00fcbernehmen
    toast("Gespeichert");
    tfRenderCfg(); tfRenderMap();
  }
  catch (e) { toast(e.message); }
}

async function tfLock(d, locked) {
  if (locked && !await confirmDlg("Gerät sperren?", `„${d.name}" wird sofort gesperrt und gibt einen Alarmton von sich. Entsperren geht nur hier.`, "Sperren")) return;
  if (!locked && !await confirmDlg("Entsperren?", `Sperre und Alarm von „${d.name}" aufheben? (Bei einem echten Diebstahl überlegen, ob das gewollt ist.)`, "Entsperren")) return;
  try { await api(`/api/admin/theft/${d.id}/lock`, json("POST", { locked })); toast(locked ? "Wird gesperrt …" : "Wird entsperrt …"); tfLoad(); }
  catch (e) { toast(e.message); }
}

async function tfTest(d) {
  if (!await confirmDlg("Testalarm auslösen?", `„${d.name}" zeigt den Sperrbildschirm und gibt den Alarmton. Der Test endet nach 2 Minuten von selbst – oder sofort per „Entsperren". Es wird KEIN echter Alarm an die Admin-App geschickt.`, "Test starten")) return;
  try { await api(`/api/admin/theft/${d.id}/test`, json("POST", {})); toast("Testalarm ausgelöst – das Gerät sperrt sich beim nächsten Abgleich (wenige Sekunden)."); tfLoad(); }
  catch (e) { toast(e.message); }
}

async function tfShowTrack(d) {
  try {
    const r = await api(`/api/admin/theft/${d.id}/track?hours=24`);
    if (TF.track) { TF.track.remove(); TF.track = null; }
    const pts = r.points.filter(p => p.lat != null).map(p => [p.lat, p.lon]);
    if (!pts.length) { toast("Keine Standorte in den letzten 24 Stunden"); return; }
    TF.track = L.polyline(pts, { color: "#1d4ed8", weight: 3, opacity: 0.8 }).addTo(TF.map);
    TF.map.fitBounds(pts, { padding: [40, 40] });
    toast(`Spur der letzten 24 Stunden (${pts.length} Punkte) – zum Ausblenden Reiter neu öffnen`);
  } catch (e) { toast(e.message); }
}
