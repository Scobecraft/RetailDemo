"use strict";
// Spec-Lasche: zugeklappt nur ein schmaler Reiter am Bildschirmrand, aufgeklappt das Datenblatt.

function render(vm) {
  document.getElementById("brand").innerHTML = vm.logo
    ? `<img src="${escapeHtml(vm.logo)}" alt="">`
    : vm.store_name ? `<span class="store">${escapeHtml(vm.store_name)}</span>` : "";
  const specs = (vm.specs || []).filter(s => s.value);
  const price = specs.find(s => isPrice(s.label));
  const rows = specs.filter(s => s !== price).map((s, i) => `
    <div class="row" style="animation-delay:${0.08 + i * 0.05}s">
      <div class="ic">${specIcon(s.label)}</div>
      <div><div class="lb">${escapeHtml(s.label || "Ausstattung")}</div><div class="vl">${escapeHtml(s.value)}</div></div>
    </div>`).join("");
  document.getElementById("content").innerHTML = `
    ${vm.manufacturer ? `<div class="eyebrow">${escapeHtml(vm.manufacturer)}</div>` : ""}
    <h1>${escapeHtml(vm.display_name || "Dieser Laptop")}</h1>
    ${price ? `<div class="price"><small>${escapeHtml(price.label || "Preis")}</small><strong>${escapeHtml(price.value)}</strong></div>` : ""}
    ${rows}`;
}

function setOpen(open) {
  if (open) {
    // Animation der Zeilen neu starten
    document.body.classList.remove("open");
    void document.body.offsetWidth;
  }
  document.body.classList.toggle("open", open);
}

document.getElementById("tab").addEventListener("click", () => { rd.send("panel:toggle", true); });
document.getElementById("close").addEventListener("click", () => rd.send("panel:toggle", false));
document.getElementById("play").addEventListener("click", () => rd.send("demo:startNow"));
window.addEventListener("keydown", e => { if (e.key === "Escape") rd.send("panel:toggle", false); });

rd.on("vm", render);
rd.on("panel:open", setOpen);
rd.invoke("vm").then(render);
