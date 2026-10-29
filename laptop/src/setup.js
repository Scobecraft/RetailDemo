"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let info = null;

function ago(ms) {
  if (!ms) return "noch nie";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  return `vor ${Math.floor(s / 86400)} Tagen`;
}

function msg(text, ok) {
  $("#msg").textContent = text || "";
  $("#msg").className = "msg " + (ok ? "ok" : "err");
}

async function load(fillForm) {
  info = await rd.invoke("setup:get");
  if (info.platform === "darwin") {
    $("#whereTray").textContent = "Symbol oben in der Menüleiste";
    $("#hotkey").textContent = "⌃ ctrl + ⌥ option + ⇧ shift + D";
  }
  if (fillForm) {
    $("#url").value = info.serverUrl;
    $("#token").placeholder = info.hasToken ? "•••••••• (unverändert lassen)" : "";
    $("#pin").placeholder = info.hasPin ? "unverändert lassen" : "";
    $("#autostart").checked = info.autostart;
  }
  const m = info.manifest;
  const rows = [
    ["Verbunden mit", info.serverUrl || "–"],
    ["Abgleich", info.state || "–"],
    ["Letzter Abgleich", ago(info.lastSync)],
    ["Fehler", info.lastError || "keine"],
    ["Name in der Demo", (m && m.display_name) || "–"],
    ["Playlist", m ? `${m.playlist_name} (${m.items} Medien)` : "–"],
    ["Demo startet nach", m && m.idle_timeout_s ? `${m.idle_timeout_s} s ohne Bedienung` : "60 s ohne Bedienung"],
    ["Geräte-ID", info.deviceId || "–"],
    ["App-Version", info.version],
  ];
  $("#status").innerHTML = rows.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join("");
  $("#start").disabled = !info.hasPin || !info.serverUrl;
  const f = info.filter;
  const wanted = { off: "aus", family: "Jugendschutz", strict: "Jugendschutz streng" }[f.wanted] || f.wanted;
  $("#filterStatus").innerHTML = [
    ["Eingestellt", `${wanted}${f.domains ? ` + ${f.domains} eigene gesperrte Seiten` : ""}`],
    ["Auf diesem Gerät", !f.supported ? "nur auf dem Mac verfügbar" : f.installed ? (f.state || "eingerichtet, zurzeit aus") : "nicht eingerichtet"],
  ].map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join("");
  $("#filterInstall").hidden = !f.supported || f.installed;
  $("#filterRemove").hidden = !f.supported || !f.installed;
  if (info.local) {
    $("#local").innerHTML = `<b>${esc(info.local.marketing_name || info.local.model)}</b>` +
      `<ul class="specs">${info.local.specs.map(s => `<li>${esc(s.label)}: ${esc(s.value)}</li>`).join("")}</ul>`;
  }
}

$("#form").addEventListener("submit", async e => {
  e.preventDefault();
  if ($("#pin").value !== $("#pin2").value) return msg("Die PINs stimmen nicht überein");
  $("#save").disabled = true;
  msg("Verbinde …", true);
  try {
    const r = await rd.invoke("setup:save", {
      serverUrl: $("#url").value, deviceToken: $("#token").value, pin: $("#pin").value, autostart: $("#autostart").checked,
    });
    if (r.error) msg(r.error);
    else {
      $("#token").value = $("#pin").value = $("#pin2").value = "";
      msg(r.syncError ? `Gespeichert, aber Abgleich fehlgeschlagen: ${r.syncError}` : "✓ Verbunden und Inhalte geladen", !r.syncError);
    }
  } finally {
    $("#save").disabled = false;
    load(true);
  }
});

$("#sync").addEventListener("click", async () => {
  $("#sync").disabled = true;
  const err = await rd.invoke("setup:sync");
  $("#sync").disabled = false;
  msg(err ? `Abgleich fehlgeschlagen: ${err}` : "✓ Abgleich erfolgreich", !err);
  load(false);
});
async function filterAction(channel, button) {
  button.disabled = true;
  $("#filterMsg").textContent = "Bitte das Admin-Passwort im macOS-Dialog eingeben …";
  $("#filterMsg").className = "msg ok";
  const r = await rd.invoke(channel);
  button.disabled = false;
  $("#filterMsg").textContent = r.error ? r.error : channel === "filter:install" ? "✓ Kindersicherung eingerichtet" : "✓ Kindersicherung entfernt";
  $("#filterMsg").className = "msg " + (r.error ? "err" : "ok");
  load(false);
}
$("#filterInstall").addEventListener("click", e => filterAction("filter:install", e.target));
$("#filterRemove").addEventListener("click", e => { if (confirm("Kindersicherung von diesem Mac entfernen?")) filterAction("filter:uninstall", e.target); });
$("#start").addEventListener("click", () => rd.send("setup:startDemo"));
$("#quit").addEventListener("click", () => { if (confirm("Retail Demo Laptop wirklich beenden? Die Demo läuft dann erst nach dem nächsten Neustart wieder.")) rd.send("setup:quit"); });
rd.on("state", () => load(false));

load(true);
setInterval(() => load(false), 5000);
