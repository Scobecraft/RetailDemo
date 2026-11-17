// Reiter "Statistik", "Benachrichtigungen", "Backup" und "Protokoll".
// Nutzt $, el, api, json, toast, dialog, confirmDlg, size, state, CHUNK (index.html).
"use strict";

const OPS = { stats: { days: 7, device: "" }, timer: null };
const opsNum = (v, d = 0) => Number(v || 0).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const opsHours = s => s >= 3600 ? `${opsNum(s / 3600, 1)} Std.` : `${opsNum(Math.round(s / 60))} Min.`;
const opsWhen = t => new Date(t * 1000).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

function showOps(tab) {
  clearTimeout(OPS.timer);
  if (tab === "stats") opsStats();
  else if (tab === "alerts") opsAlerts();
  else if (tab === "backup") opsBackup();
  else if (tab === "activity") opsActivity(true);
}

// ---------------------------------------------------------------- Statistik
function opsBars(values, labels, fmt, { height = 160, tip } = {}) {
  // einfaches Säulendiagramm (eine Reihe), mit Tooltip beim Darüberfahren
  const max = Math.max(1, ...values);
  const wrap = el("div", { class: "ops-bars", style: `height:${height}px` });
  const tipEl = el("div", { class: "ops-tip", hidden: true });
  values.forEach((v, i) => {
    const bar = el("div", { class: "ops-bar" + (v ? "" : " zero"), style: `height:${Math.max(v ? 3 : 0, 100 * v / max)}%` });
    const col = el("div", { class: "ops-col", onmouseenter: () => { tipEl.hidden = false; tipEl.textContent = tip ? tip(i) : `${labels[i]}: ${fmt(v)}`; },
      onmouseleave: () => { tipEl.hidden = true; } }, bar);
    wrap.append(col);
  });
  const axis = el("div", { class: "ops-axis" }, ...labels.map((l, i) => el("span", {}, labels.length > 14 && i % Math.ceil(labels.length / 10) ? "" : l)));
  return el("div", { class: "ops-chart" }, el("div", { class: "ops-ymax" }, fmt(max)), wrap, axis, tipEl);
}

async function opsStats() {
  const page = $("[data-page=stats]");
  const S = OPS.stats;
  let d;
  try { d = await api(`/api/admin/stats?days=${S.days}&device_id=${encodeURIComponent(S.device)}`); }
  catch (e) { page.replaceChildren(el("h2", {}, "Statistik"), el("p", { class: "muted" }, e.message)); return; }
  const devSel = el("select", { class: "ops-dev", onchange: e => { S.device = e.target.value; opsStats(); } },
    el("option", { value: "" }, "Alle Geräte"), ...d.devices.map(x => el("option", { value: x.id, selected: x.id === S.device }, x.name)));
  const range = el("div", { class: "ops-seg" }, ...[[1, "Heute"], [7, "7 Tage"], [30, "30 Tage"], [90, "90 Tage"]].map(([n, l]) =>
    el("button", { class: n === S.days ? "on" : "", onclick: () => { S.days = n; opsStats(); } }, l)));
  const T = d.totals;
  const openMin = d.per_day.reduce((a, x) => a + x.opening_min, 0);
  const uptime = d.devices.length && openMin ? d.devices.reduce((a, x) => a + Math.min(1, x.online_min / openMin), 0) / d.devices.length * 100 : null;
  const tile = (label, value, note) => el("div", { class: "ops-tile" }, el("small", {}, label), el("b", {}, value), note ? el("span", { class: "muted" }, note) : null);
  const dayLabels = d.per_day.map(x => new Date(x.day).toLocaleDateString("de-DE", d.days > 7 ? { day: "2-digit", month: "2-digit" } : { weekday: "short" }));
  const maxPlays = Math.max(1, ...d.media.map(m => m.plays));
  const empty = !T.plays && !T.touches && !d.devices.some(x => x.online_min);
  page.replaceChildren(...[
    el("div", { class: "row" }, el("div", {}, el("h2", {}, "Statistik"),
      el("p", { class: "sub" }, "Was auf den Demo-Geräten lief, wie oft Kunden sie angefasst haben und wie zuverlässig sie liefen.")),
      el("div", { class: "spacer" }), devSel, range),
    empty ? el("p", { class: "hint" }, "Noch keine Daten in diesem Zeitraum. Die Demo-App ab Version 1.13 meldet ihre Wiedergaben automatisch.") : null,
    el("div", { class: "ops-tiles" },
      tile("Wiedergaben", opsNum(T.plays), `${opsHours(T.play_s)} Laufzeit`),
      tile("Kundenkontakte", opsNum(T.touches), T.customer_min ? `${opsHours(T.customer_min * 60)} ausprobiert` : "Berührungen der Geräte"),
      tile("Geräte", opsNum(T.devices), "mit Daten im Zeitraum"),
      tile("Online in Betriebszeit", uptime == null ? "–" : `${opsNum(uptime, 0)} %`, "Durchschnitt aller Geräte")),
    el("div", { class: "ops-grid" },
      el("section", { class: "panel ops-card span2" }, el("h3", {}, "Wiedergaben pro Tag"),
        opsBars(d.per_day.map(x => x.plays), dayLabels, v => opsNum(v),
          { tip: i => `${new Date(d.per_day[i].day).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit" })}: ${opsNum(d.per_day[i].plays)} Wiedergaben · ${opsNum(d.per_day[i].touches)} Kundenkontakte` })),
      el("section", { class: "panel ops-card" }, el("h3", {}, "Wann Kunden die Geräte anfassen"),
        opsBars(d.touch_hours.slice(7, 22), Array.from({ length: 15 }, (_, i) => String(i + 7)), v => opsNum(v),
          { height: 120, tip: i => `${i + 7}–${i + 8} Uhr: ${opsNum(d.touch_hours[i + 7])} Kontakte` })),
      el("section", { class: "panel ops-card span3" }, el("h3", {}, "Meistgespielte Inhalte"),
        d.media.length ? el("div", { class: "ops-rank" }, ...d.media.slice(0, 15).map(m => el("div", { class: "ops-rank-row", title: `${m.title}: ${opsNum(m.plays)}× · ${opsHours(m.play_s)} · ${m.completed_pct} % ganz gesehen` },
          el("span", { class: "ops-rank-name" }, m.title),
          el("div", { class: "ops-rank-track" }, el("div", { class: "ops-rank-fill", style: `width:${100 * m.plays / maxPlays}%` })),
          el("b", {}, `${opsNum(m.plays)}×`), el("span", { class: "muted" }, opsHours(m.play_s)))))
          : el("p", { class: "muted" }, "Noch keine Wiedergaben.")),
      el("section", { class: "panel ops-card span3" }, el("h3", {}, "Geräte"),
        el("div", { class: "ops-table-wrap" }, el("table", { class: "ops-table" },
          el("thead", {}, el("tr", {}, ...["Gerät", "Online", "davon Demo", "Kunde probiert", "Wiedergaben", "Kontakte"].map(h => el("th", {}, h)))),
          el("tbody", {}, ...d.devices.map(x => el("tr", {},
            el("td", {}, x.name),
            el("td", {}, x.uptime_pct == null ? opsHours(x.online_min * 60) : el("span", { class: "ops-pct" + (x.uptime_pct < 80 ? " low" : "") }, `${opsNum(x.uptime_pct, 0)} %`), el("small", { class: "muted" }, ` ${opsHours(x.online_min * 60)}`)),
            el("td", {}, opsHours(x.demo_min * 60)), el("td", {}, opsHours(x.customer_min * 60)),
            el("td", {}, opsNum(x.plays)), el("td", {}, opsNum(x.touches)))))))),
    ),
    el("p", { class: "muted ops-foot" }, "Online-Zeit: Anteil der Betriebszeit laut Zeitplan, in der sich das Gerät gemeldet hat. Kontakte: wie oft ein Kunde die laufende Demo durch Antippen beendet hat. ",
      el("button", { class: "linkbtn inline", onclick: async () => {
        if (!await confirmDlg("Statistik zurücksetzen?", "Alle Wiedergaben und Online-Zeiten werden gelöscht.", "Zurücksetzen")) return;
        await api("/api/admin/stats?confirm=true", { method: "DELETE" }); opsStats();
      } }, "Statistik zurücksetzen"))].filter(Boolean));
}

// ---------------------------------------------------------------- Benachrichtigungen
const OPS_LEVEL = { info: "ℹ", warn: "⚠", error: "⛔" };
async function opsAlerts() {
  const page = $("[data-page=alerts]");
  let d, cfg;
  try { [d, cfg] = await Promise.all([api("/api/admin/alerts?limit=100"), api("/api/admin/alerts/config")]); }
  catch (e) { page.replaceChildren(el("h2", {}, "Benachrichtigungen"), el("p", { class: "muted" }, e.message)); return; }
  const c = { ...cfg, enabled: { ...cfg.enabled } };
  const save = async () => { try { await api("/api/admin/alerts/config", json("PUT", c)); toast("Gespeichert"); } catch (e) { toast(e.message); } };
  const kinds = Object.entries(cfg.kinds).map(([k, label]) => el("label", { class: "chip" },
    el("input", { type: "checkbox", checked: c.enabled[k], onchange: e => { c.enabled[k] = e.target.checked; save(); } }), label));
  const mins = el("input", { type: "number", min: 5, max: 240, value: c.offline_minutes, style: "width:80px", onchange: e => { c.offline_minutes = +e.target.value; save(); } });
  const hours = el("input", { type: "checkbox", checked: c.only_opening_hours, onchange: e => { c.only_opening_hours = e.target.checked; save(); } });
  page.replaceChildren(
    el("div", { class: "row" }, el("div", {}, el("h2", {}, "Benachrichtigungen"),
      el("p", { class: "sub" }, "Alarme kommen als Push-Benachrichtigung in die Admin-App (ab Version 1.8) und stehen hier in der Liste.")),
      el("div", { class: "spacer" }),
      el("button", { class: "btn small", onclick: async () => { await api("/api/admin/alerts/test", json("POST", {})); toast("Test-Benachrichtigung verschickt"); opsAlerts(); } }, "Test senden"),
      el("button", { class: "btn small", onclick: async () => { await api("/api/admin/alerts/ack-all", json("POST", {})); opsAlerts(); } }, "Alle als gelesen")),
    el("section", { class: "panel ops-card" }, el("h3", {}, "Worüber benachrichtigen?"),
      el("div", { class: "target" }, ...kinds),
      el("div", { class: "row ops-cfg" }, el("span", {}, "Gerät gilt als offline nach"), mins, el("span", {}, "Minuten"),
        el("label", { class: "chip" }, hours, "nur während der Betriebszeiten"))),
    el("div", { class: "ops-alerts" }, ...(d.alerts.length ? d.alerts.map(a => el("div", { class: `ops-alert ${a.level}${a.acked ? " acked" : ""}${a.resolved ? " resolved" : ""}` },
      el("span", { class: "ops-alert-ic" }, OPS_LEVEL[a.level] || "•"),
      el("div", { class: "ops-alert-body" }, el("b", {}, a.title), a.body ? el("span", {}, a.body) : null,
        el("small", { class: "muted" }, `${opsWhen(a.t)} · ${cfg.kinds[a.kind] || "Test"}${a.resolved ? " · erledigt" : ""}`)),
      a.data?.action === "bed_clear" && !a.resolved ? el("button", { class: "btn small primary", onclick: async () => {
        const r = await api("/api/admin/druck/bed-clear", json("POST", {})); toast(r.started ? `Druckbett frei – „${r.started}“ startet` : "Druckbett frei ✓"); opsAlerts();
      } }, "✓ Druckbett ist frei") : null))
      : [el("p", { class: "muted" }, "Noch keine Benachrichtigungen.")])));
  OPS.timer = setTimeout(() => { if (!page.hidden) opsAlerts(); }, 30000);
}

// ---------------------------------------------------------------- Backup
async function opsBackup() {
  const page = $("[data-page=backup]");
  let d;
  try { d = await api("/api/admin/backups"); }
  catch (e) { page.replaceChildren(el("h2", {}, "Backup"), el("p", { class: "muted" }, e.message)); return; }
  const c = { ...d.config };
  const save = async () => { try { await api("/api/admin/backups/config", json("PUT", c)); toast("Gespeichert"); } catch (e) { toast(e.message); } };
  const run = async media => {
    btns.forEach(b => b.disabled = true); toast("Backup läuft …");
    try { const b = await api(`/api/admin/backups?include_media=${media}`, json("POST", {})); toast(`Backup erstellt (${size(b.size)})`); }
    catch (e) { toast(e.message); }
    opsBackup();
  };
  const btns = [el("button", { class: "btn primary", onclick: () => run(false) }, "Jetzt sichern"),
    el("button", { class: "btn", title: `Medien zusammen ca. ${size(d.media_bytes || 0)}`, onclick: () => run(true) }, "Mit allen Medien sichern")];
  const fileIn = el("input", { type: "file", accept: ".gz,.tgz", hidden: true, onchange: async () => {
    const f = fileIn.files[0]; fileIn.value = "";
    if (!f) return;
    toast("Backup wird hochgeladen …");
    try {
      const { id } = await api("/api/admin/uploads", json("POST", { filename: f.name, size: f.size, kind: "backup" }));
      for (let off = 0; off < f.size; off += CHUNK)
        await api(`/api/admin/uploads/${id}?offset=${off}`, { method: "PUT", body: f.slice(off, off + CHUNK), headers: { "Content-Type": "application/octet-stream" } });
      await api(`/api/admin/uploads/${id}/complete`, json("POST", {}));
      toast("Hochgeladen – jetzt in der Liste „Wiederherstellen“ wählen");
    } catch (e) { toast(e.message); }
    opsBackup();
  } });
  page.replaceChildren(...[
    el("div", { class: "row" }, el("div", {}, el("h2", {}, "Backup"),
      el("p", { class: "sub" }, "Sichert Datenbank, Playlists, Geräte, Einstellungen, 3D-Druck, Video-Schnitt und Zeitraffer – auf Wunsch auch alle Medien.")),
      el("div", { class: "spacer" }), el("div", { class: "row" }, ...btns)),
    d.running ? el("p", { class: "hint" }, "Backup läuft gerade …") : null,
    d.last_error ? el("p", { class: "hint ops-bad" }, "Letztes Backup fehlgeschlagen: " + d.last_error) : null,
    el("section", { class: "panel ops-card" }, el("h3", {}, "Automatisch"),
      el("div", { class: "row ops-cfg" },
        el("label", { class: "chip" }, el("input", { type: "checkbox", checked: c.enabled, onchange: e => { c.enabled = e.target.checked; save(); } }), "Jeden Tag sichern um"),
        el("input", { type: "time", value: c.time, onchange: e => { c.time = e.target.value; save(); } }),
        el("span", {}, "· die letzten"), el("input", { type: "number", min: 1, max: 60, value: c.keep, style: "width:70px", onchange: e => { c.keep = +e.target.value; save(); } }),
        el("span", {}, "Backups behalten"),
        el("label", { class: "chip" }, el("input", { type: "checkbox", checked: c.include_media, onchange: e => { c.include_media = e.target.checked; save(); } }), "mit Medien")),
      el("p", { class: "muted" }, d.external ? `Ablage: Ordner „backups“ neben „data“ auf dem Server (${size(d.disk_free)} frei). Für noch mehr Sicherheit den Ordner in docker-compose.yml auf ein NAS legen.`
        : `Ablage: im Datenordner (${size(d.disk_free)} frei). Tipp: in docker-compose.yml einen eigenen Backup-Ordner einbinden.`)),
    el("section", { class: "panel ops-card" }, el("div", { class: "row" }, el("h3", {}, "Vorhandene Backups"), el("div", { class: "spacer" }),
      el("button", { class: "btn small", onclick: () => fileIn.click() }, "Backup-Datei hochladen …"), fileIn),
      d.backups.length ? el("div", { class: "ops-backups" }, ...d.backups.map(b => el("div", { class: "ops-backup" },
        el("div", {}, el("b", {}, opsWhen(b.created)), el("small", { class: "muted" }, ` · ${size(b.size)}${b.media ? " · mit Medien" : ""}`)),
        el("div", { class: "spacer" }),
        el("a", { class: "btn small", href: `/api/admin/backups/${b.name}/file`, download: b.name }, "Herunterladen"),
        el("button", { class: "btn small", onclick: async () => {
          if (!await confirmDlg("Backup wiederherstellen?", `Der Stand vom ${opsWhen(b.created)} wird eingespielt. Alles, was seitdem geändert wurde, geht verloren (vorher wird automatisch noch ein Backup vom jetzigen Stand gemacht). Der Server startet dabei kurz neu.`, "Wiederherstellen")) return;
          try { await api(`/api/admin/backups/${b.name}/restore`, json("POST", { confirm: true })); toast("Wird wiederhergestellt – Server startet neu …"); setTimeout(() => location.reload(), 8000); }
          catch (e) { toast(e.message); }
        } }, "Wiederherstellen"),
        el("button", { class: "btn small danger", onclick: async () => {
          if (!await confirmDlg("Backup löschen?", `Backup vom ${opsWhen(b.created)} löschen?`)) return;
          await api(`/api/admin/backups/${b.name}`, { method: "DELETE" }); opsBackup();
        } }, "Löschen"))))
        : el("p", { class: "muted" }, "Noch keine Backups."))].filter(Boolean));
}

// ---------------------------------------------------------------- Protokoll
function opsSearchIcon() {
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  const c = document.createElementNS(ns, "circle"); c.setAttribute("cx", 11); c.setAttribute("cy", 11); c.setAttribute("r", 7);
  const p = document.createElementNS(ns, "path"); p.setAttribute("d", "m20 20-4-4");
  svg.append(c, p);
  return svg;
}
async function opsActivity(reset) {
  const page = $("[data-page=activity]");
  if (reset || !OPS.act) {
    OPS.act = { items: [], q: "", more: false };
    OPS.actList = el("div", { class: "ops-act" });
    OPS.actMore = el("button", { class: "btn small", hidden: true, onclick: () => opsActivity(false) }, "Ältere laden");
    let t;
    const search = el("input", { type: "search", placeholder: "Suchen (z. B. gelöscht, Playlist, Admin-App) …",
      oninput: e => { clearTimeout(t); t = setTimeout(() => { OPS.act.q = e.target.value; OPS.act.items = []; opsActivity(false); }, 300); } });
    page.replaceChildren(el("h2", {}, "Protokoll"),
      el("p", { class: "sub" }, "Wer hat wann was geändert – über die Webseite oder die Admin-App."),
      el("div", { class: "search" }, opsSearchIcon(), search), OPS.actList, OPS.actMore);
  }
  const A = OPS.act;
  const before = A.items.length ? A.items[A.items.length - 1].id : 0;
  const d = await api(`/api/admin/activity?limit=100&before=${before}&q=${encodeURIComponent(A.q)}`);
  A.items.push(...d.items);
  OPS.actMore.hidden = !d.more;
  let lastDay = "";
  const rows = [];
  for (const a of A.items) {
    const day = new Date(a.t * 1000).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
    if (day !== lastDay) { rows.push(el("div", { class: "ops-act-day" }, day)); lastDay = day; }
    rows.push(el("div", { class: "ops-act-row" + (a.ok ? "" : " bad") },
      el("span", { class: "ops-act-time" }, new Date(a.t * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })),
      el("span", { class: "ops-act-who " + (a.who === "Admin-App" ? "app" : "web") }, a.who),
      el("span", { class: "ops-act-text" }, a.action, a.ok ? null : el("small", {}, ` – fehlgeschlagen (${a.detail})`)),
      el("span", { class: "muted ops-act-ip" }, a.ip || "")));
  }
  OPS.actList.replaceChildren(...(rows.length ? rows : [el("p", { class: "muted" }, "Noch keine Einträge.")]));
}
