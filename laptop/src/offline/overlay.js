"use strict";
// Anzeige für USB-Update und Herunterfahren. Zustand kommt vom Hauptprozess:
// { kind: "busy" | "done" | "error" | "shutdown", title, text, progress (0..1 oder null), hint, logo, store_name }
const $ = id => document.getElementById(id);

rd.on("overlay", s => {
  document.body.dataset.theme = s.theme || "standard";
  $("brand").innerHTML = s.logo ? `<img src="${escapeHtml(s.logo)}" alt="">` : s.store_name ? `<div class="name">${escapeHtml(s.store_name)}</div>` : "";
  $("title").textContent = s.title || "";
  $("text").textContent = s.text || "";
  $("ok").hidden = s.kind !== "done";
  $("fail").hidden = s.kind !== "error";
  const showBar = s.kind === "busy" || s.kind === "shutdown";
  $("bar").hidden = !showBar;
  $("bar").classList.toggle("indeterminate", showBar && s.progress == null);
  $("fill").style.width = s.progress == null ? "" : `${Math.round(s.progress * 100)}%`;
  $("pct").textContent = showBar && s.progress != null && s.kind === "busy" ? `${Math.floor(s.progress * 100)} %` : "";
  $("hint").hidden = !s.hint;
  $("hint").textContent = s.hint || "";
});
