"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kv = rows => rows.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join("");
const time = ms => ms ? new Date(ms).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "–";

async function load() {
  const i = await rd.invoke("info:get");
  if (document.activeElement !== $("#theme")) $("#theme").value = i.theme;
  $("#status").innerHTML = kv([
    ["Programmversion", i.version],
    ["Videos / Bilder", `${i.videos} / ${i.images}`],
    ["Reguläre / wöchentliche Werbung", `${i.regular} / ${i.weekly}`],
    ["Logo", i.hasLogo ? "vom USB-Stick" : "expert klein (mitgeliefert)"],
    ["Ladenname", i.storeName],
    ["Letztes USB-Update", time(i.lastUpdate)],
    ["Demo startet nach", `${i.idleS} s ohne Bedienung`],
    ["Herunterfahren", i.shutdownAt ? `um ${time(i.shutdownAt)}` : "aus"],
  ]);
  const l = i.local || {};
  $("#device").innerHTML = `<div class="kv">${kv([
    ["Angezeigter Name", i.displayName],
    ["Modell-Code", l.model || "–"],
    ["Eintrag in geraete.txt", i.override ? "ja" : "nein"],
  ])}</div><ul>${(i.specs || []).map(s => `<li>${esc(s.label)}: ${esc(s.value)}</li>`).join("")}</ul>`;
}

$("#theme").addEventListener("change", e => rd.send("info:setTheme", e.target.value));
$("#start").addEventListener("click", () => rd.send("info:startDemo"));
$("#quit").addEventListener("click", () => { if (confirm("Demo-Programm beenden? Es startet beim nächsten Einschalten wieder.")) rd.send("info:quit"); });
load();
setInterval(load, 5000);
