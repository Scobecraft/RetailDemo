// Reiter "YouTube-Import": Werbevideos über ScobeTube auf den Server laden (scobetube.py) und gleich in
// Playlists packen oder im Video-Schnitt bearbeiten. Ton geht als Musik in den Video-Schnitt.
// Nutzt $, el, api, json, toast, dialog, state, loadAll (index.html) und edOpen/edNew/edAddClip (editor.js).
"use strict";

const YT = { built: false, visible: false, cfg: null, jobs: [], results: [], timer: null, targets: new Set(), els: {} };

function ytBuild() {
  const page = $("[data-page=youtube]");
  const E = YT.els;
  E.url = el("input", { type: "text", placeholder: "YouTube-Link einfügen oder Suchbegriff eingeben …", autocomplete: "off",
    onkeydown: e => { if (e.key === "Enter") ytGo(); } });
  E.go = el("button", { class: "btn primary", onclick: ytGo }, "Laden");
  E.quality = el("select", {}, ...[["1080", "Full HD (1080p)"], ["720", "HD (720p)"], ["1440", "1440p"], ["best", "Beste Qualität"], ["480", "480p (klein)"]]
    .map(([v, t]) => el("option", { value: v }, t)));
  E.target = el("select", { onchange: ytTargetUi }, el("option", { value: "media" }, "Video → Medien"), el("option", { value: "audio" }, "Nur Ton → Musik für den Video-Schnitt"));
  E.start = el("input", { type: "text", placeholder: "0:00", style: "width:90px" });
  E.end = el("input", { type: "text", placeholder: "Ende", style: "width:90px" });
  E.title = el("input", { type: "text", placeholder: "wie auf YouTube" });
  E.sponsor = el("input", { type: "checkbox" });
  E.playlists = el("div", { class: "target" });
  E.results = el("div", { class: "yt-results" });
  E.jobs = el("div", { class: "queue" });
  E.setup = el("div", { class: "hint", hidden: true });
  E.cfgBtn = el("button", { class: "btn small", onclick: ytSettings }, "⚙ ScobeTube-Zugang");
  E.opts = el("div", { class: "yt-opts" },
    el("div", {}, el("label", {}, "Ziel"), E.target),
    el("div", { class: "yt-q" }, el("label", {}, "Qualität"), E.quality),
    el("div", {}, el("label", {}, "Zuschnitt von – bis (optional)"), el("div", { class: "row" }, E.start, "–", E.end)),
    el("div", { class: "yt-grow" }, el("label", {}, "Name (optional)"), E.title),
    el("label", { class: "chip yt-sb", title: "Gesponserte Abschnitte, Intros usw. automatisch herausschneiden" }, E.sponsor, "SponsorBlock"));

  page.replaceChildren(
    el("div", { class: "row" },
      el("div", {}, el("h2", {}, "YouTube-Import"),
        el("p", { class: "sub" }, "Werbevideos direkt auf den Server laden, umwandeln und in Playlists packen oder im Video-Schnitt bearbeiten.")),
      el("div", { class: "spacer" }), E.cfgBtn),
    E.setup,
    el("div", { class: "panel yt-panel" },
      el("div", { class: "yt-bar" }, E.url, E.go),
      E.opts, E.playlists,
      el("p", { class: "muted yt-note" }, "Bitte nur Videos verwenden, die ihr zeigen dürft – z. B. Werbung der Hersteller, die ihr im Markt vorführen dürft.")),
    E.results,
    el("h3", { class: "yt-h" }, "Importe"),
    E.jobs);
  YT.built = true;
}

function ytTargetUi() {
  const audio = YT.els.target.value === "audio";
  YT.els.quality.closest(".yt-q").hidden = audio;
  YT.els.playlists.hidden = audio;
}

function ytRenderPlaylists() {
  const box = YT.els.playlists;
  for (const id of [...YT.targets]) if (!state.playlists.some(p => p.id === id)) YT.targets.delete(id);
  if (!state.playlists.length) { box.replaceChildren(); return; }
  box.replaceChildren(el("span", {}, "Gleich hinzufügen zu:"), ...state.playlists.map(p =>
    el("label", { class: "chip" },
      el("input", { type: "checkbox", checked: YT.targets.has(p.id), onchange: e => e.target.checked ? YT.targets.add(p.id) : YT.targets.delete(p.id) }),
      (p.is_default ? "★ " : "") + p.name)));
}

function ytRenderSetup() {
  const E = YT.els, c = YT.cfg || {};
  E.setup.hidden = !!c.configured;
  if (!c.configured) E.setup.replaceChildren(
    el("b", {}, "Noch nicht eingerichtet. "),
    "Der Import läuft über euren ScobeTube-Server. Legt dort am besten ein eigenes Konto für die Demo-Webseite an (ohne Zwei-Faktor-Anmeldung, Rechte „Herunterladen“ und „Dateien“) und tragt es hier ein. ",
    el("button", { class: "btn small primary", onclick: ytSettings }, "Jetzt einrichten"));
  E.cfgBtn.textContent = c.configured ? `⚙ ScobeTube (${c.username})` : "⚙ ScobeTube-Zugang";
}

async function ytSettings() {
  const c = YT.cfg || {};
  const url = el("input", { type: "text", value: c.url || "", placeholder: "http://192.168.1.10:8081" });
  const user = el("input", { type: "text", value: c.username || "", autocomplete: "off" });
  const pass = el("input", { type: "password", autocomplete: "new-password", placeholder: c.configured ? "unverändert lassen" : "" });
  const err = el("p", { class: "yt-err" });
  for (;;) {
    const v = await dialog("ScobeTube-Zugang", [
      el("p", { class: "muted" }, "Adresse eures ScobeTube-Servers, wie der Demo-Server ihn erreicht (läuft er auf demselben Rechner: IP des Rechners und Port 8081). Das Passwort wird nur auf dem Server gespeichert und nie wieder angezeigt."),
      el("label", {}, "Adresse"), url, el("label", {}, "Benutzername"), user, el("label", {}, "Passwort"), pass, err],
      [["Abbrechen", ""], ["Speichern & testen", "ok", "primary"]]);
    if (v !== "ok") return;
    try {
      const r = await api("/api/admin/scobetube", json("PUT", { url: url.value, username: user.value, password: pass.value }));
      toast(`Verbunden${r.user ? " als " + r.user : ""} ✓`);
      break;
    } catch (e) { err.textContent = e.message; }
  }
  YT.cfg = await api("/api/admin/scobetube");
  ytRenderSetup();
}

const ytIsUrl = s => /^https?:\/\//i.test(s) || /^(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(s);

async function ytGo() {
  const q = YT.els.url.value.trim();
  if (!q) { YT.els.url.focus(); return; }
  if (!YT.cfg?.configured) { ytSettings(); return; }
  if (ytIsUrl(q)) { await ytImport(/^https?:/i.test(q) ? q : "https://" + q); YT.els.url.value = ""; return; }
  YT.els.go.disabled = true;
  YT.els.results.replaceChildren(el("p", { class: "muted" }, "Suche auf YouTube …"));
  try {
    YT.results = (await api("/api/admin/scobetube/search?q=" + encodeURIComponent(q))).results;
    ytRenderResults();
  } catch (e) { YT.els.results.replaceChildren(el("p", { class: "yt-err" }, e.message)); }
  finally { YT.els.go.disabled = false; }
}

const ytDur = s => s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "";

function ytRenderResults() {
  const box = YT.els.results;
  if (!YT.results.length) { box.replaceChildren(el("p", { class: "muted" }, "Nichts gefunden.")); return; }
  box.replaceChildren(el("div", { class: "yt-grid" }, ...YT.results.map(r =>
    el("div", { class: "yt-card" },
      el("div", { class: "yt-thumb", style: r.thumbnail ? `background-image:url('${r.thumbnail.replace(/'/g, "%27")}')` : "" },
        r.duration ? el("span", {}, ytDur(r.duration)) : null),
      el("div", { class: "yt-meta" }, el("b", { title: r.title }, r.title), el("small", { class: "muted" }, r.uploader || "")),
      el("div", { class: "row yt-actions" },
        el("a", { class: "btn small", href: r.url, target: "_blank", rel: "noopener noreferrer" }, "Ansehen ↗"),
        el("button", { class: "btn small primary", onclick: e => { e.target.disabled = true; ytImport(r.url, r.title); } }, "Importieren"))))),
    el("button", { class: "btn small", style: "margin-top:10px", onclick: () => { YT.results = []; box.replaceChildren(); } }, "Ergebnisse ausblenden"));
}

async function ytImport(url, title) {
  const E = YT.els;
  try {
    await api("/api/admin/scobetube/import", json("POST", {
      url, target: E.target.value, quality: E.quality.value, start: E.start.value, end: E.end.value, sponsorblock: E.sponsor.checked,
      title: E.title.value || "", playlist_ids: E.target.value === "media" ? [...YT.targets] : [],
    }));
    E.title.value = ""; E.start.value = ""; E.end.value = "";
    toast("Import gestartet");
    await ytLoadJobs();
  } catch (e) { toast(e.message); }
}

async function ytLoadJobs() {
  const busy = new Set(YT.jobs.filter(j => j.state === "loading" || j.state === "transfer").map(j => j.id));
  YT.jobs = await api("/api/admin/scobetube/jobs");
  ytRenderJobs();
  // gerade fertig gewordene Videos: Medien und Playlists neu laden
  if (YT.jobs.some(j => j.state === "done" && busy.has(j.id) && j.media_id)) loadAll().catch(() => {});
  clearTimeout(YT.timer);
  if (YT.visible) YT.timer = setTimeout(() => ytLoadJobs().catch(() => {}), YT.jobs.some(j => j.state === "loading" || j.state === "transfer") ? 1500 : 10000);
}

function ytRenderJobs() {
  const box = YT.els.jobs;
  if (!YT.jobs.length) { box.replaceChildren(el("p", { class: "muted" }, "Noch nichts importiert. Link oben einfügen und „Laden“ drücken.")); return; }
  box.replaceChildren(...YT.jobs.map(j => {
    const state = j.state === "done" ? "done" : j.state === "error" ? "failed" : "";
    const label = j.state === "done" ? (j.audio_id ? "Fertig – liegt als Musik im Video-Schnitt" : "Fertig – in den Medien")
      : j.state === "error" ? (j.error || "Fehler")
      : j.state === "transfer" ? "Wird auf den Server übernommen …"
      : j.progress ? `Wird heruntergeladen … ${Math.round(j.progress)} %` : (j.note || "Wird vorbereitet …");
    const actions = [];
    if (j.state === "done" && j.media_id) {
      actions.push(el("button", { class: "btn small primary", onclick: () => ytEdit(j) }, "✂ Im Video-Schnitt bearbeiten"));
      actions.push(el("button", { class: "btn small", onclick: () => ytToPlaylist(j) }, "+ Zur Playlist"));
      actions.push(el("button", { class: "btn small", onclick: () => document.querySelector('nav [data-tab="media"]').click() }, "In den Medien"));
    }
    if (j.state === "done" && j.audio_id) actions.push(el("button", { class: "btn small primary", onclick: () => document.querySelector('nav [data-tab="editor"]').click() }, "✂ Zum Video-Schnitt"));
    if (j.state === "error") actions.push(el("button", { class: "btn small", onclick: () => ytImport(j.url, j.title) }, "Nochmal"));
    actions.push(el("button", { class: "btn small", title: j.state === "loading" ? "Abbrechen" : "Aus der Liste entfernen",
      onclick: async () => { await api(`/api/admin/scobetube/jobs/${j.id}`, { method: "DELETE" }); ytLoadJobs(); } }, j.state === "loading" ? "Abbrechen" : "✕"));
    return el("div", { class: `job yt-job ${state}` },
      el("div", { class: "yt-jthumb", style: j.media_id ? `background-image:url('${thumbUrl(j.media_id)}')` : j.thumbnail ? `background-image:url('${String(j.thumbnail).replace(/'/g, "%27")}')` : "" }),
      el("div", { class: "yt-jbody" },
        el("div", { class: "name" }, el("span", {}, j.result_title || j.title || j.url), el("span", { class: "muted" }, j.audio_id ? "♪ Ton" : "▶ Video")),
        el("div", { class: "progress" }, el("div", { style: `width:${j.state === "done" || j.state === "error" ? 100 : Math.max(3, j.progress || 0)}%` })),
        el("div", { class: "row yt-jfoot" }, el("small", { class: j.state === "error" ? "yt-err" : "muted" }, label),
          j.playlist_skipped ? el("small", { class: "muted" }, " · Playlist-Link: nur das erste Video übernommen") : null,
          el("div", { class: "spacer" }), ...actions)));
  }));
}

async function ytToPlaylist(j) {
  if (!state.playlists.length) { toast("Noch keine Playlist angelegt"); return; }
  const sel = new Set();
  const v = await dialog("Zur Playlist hinzufügen", [el("p", { class: "muted" }, j.result_title || ""),
    el("div", { class: "target" }, ...state.playlists.map(p => el("label", { class: "chip" },
      el("input", { type: "checkbox", onchange: e => e.target.checked ? sel.add(p.id) : sel.delete(p.id) }), (p.is_default ? "★ " : "") + p.name)))],
    [["Abbrechen", ""], ["Hinzufügen", "ok", "primary"]]);
  if (v !== "ok" || !sel.size) return;
  await api(`/api/admin/scobetube/jobs/${j.id}/playlists`, json("POST", { playlist_ids: [...sel] }));
  await loadAll();
  toast("Zur Playlist hinzugefügt ✓");
}

// Video in einem neuen Schnitt-Projekt öffnen (Format passend zum Video)
async function ytEdit(j) {
  const m = state.media.find(x => x.id === j.media_id) || { id: j.media_id, type: "video", title: j.result_title };
  let format = "landscape";
  try {
    const info = await api(`/api/admin/editor/media/${j.media_id}`);
    if (info.width && info.height) format = info.height > info.width * 1.1 ? "portrait" : info.width > info.height * 1.1 ? "landscape" : "square";
  } catch (e) {}
  document.querySelector('nav [data-tab="editor"]').click();
  await new Promise(r => setTimeout(r, 50));
  while (ED.visible && !ED.p) await new Promise(r => setTimeout(r, 100));
  await edNew(format);
  await edAddClip(m);
  toast("Neues Schnitt-Projekt mit dem Video angelegt");
}

async function showYoutube(on) {
  YT.visible = on;
  clearTimeout(YT.timer);
  if (!on) return;
  if (!YT.built) ytBuild();
  ytRenderPlaylists(); ytTargetUi();
  try { YT.cfg = await api("/api/admin/scobetube"); } catch (e) { YT.cfg = null; }
  ytRenderSetup();
  ytLoadJobs().catch(e => toast(e.message));
}
