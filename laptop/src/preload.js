// Brücke zwischen den Oberflächen (HTML) und dem Hauptprozess – nur freigegebene Kanäle.
const { contextBridge, ipcRenderer } = require("electron");

const SEND = ["demo:input", "demo:startNow", "panel:toggle", "setup:startDemo", "setup:quit"];
const INVOKE = ["vm", "pin:check", "setup:get", "setup:save", "setup:sync", "filter:install", "filter:uninstall"];
const LISTEN = ["vm", "demo:start", "demo:stop", "panel:open", "state"];

contextBridge.exposeInMainWorld("rd", {
  send: (ch, ...args) => { if (SEND.includes(ch)) ipcRenderer.send(ch, ...args); },
  invoke: (ch, ...args) => INVOKE.includes(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error("unbekannt")),
  on: (ch, fn) => { if (LISTEN.includes(ch)) ipcRenderer.on(ch, (_e, ...args) => fn(...args)); },
});
