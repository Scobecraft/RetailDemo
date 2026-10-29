"use strict";
let fails = 0;
const pin = document.getElementById("pin");
document.getElementById("f").addEventListener("submit", async e => {
  e.preventDefault();
  if (await rd.invoke("pin:check", pin.value)) return;
  fails++;
  pin.value = "";
  document.getElementById("err").textContent = "Falsche PIN";
  // Nach mehreren Fehlversuchen kurz sperren
  if (fails >= 3) {
    pin.disabled = true;
    setTimeout(() => { pin.disabled = false; pin.focus(); fails = 0; document.getElementById("err").textContent = ""; }, 30_000);
    document.getElementById("err").textContent = "Zu viele Fehlversuche – 30 Sekunden warten";
  }
});
// Fenster schließt sich, wenn niemand etwas eingibt
setTimeout(() => window.close(), 60_000);
