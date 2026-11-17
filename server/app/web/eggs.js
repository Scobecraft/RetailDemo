// Easter Eggs der Retail-Demo-Webseite. Alles harmlos, nur Spaß – nichts wird gespeichert oder verändert.
// Nutzt $, el, toast, dialog (index.html).
"use strict";

(() => {
  const ORANGE = "#ee7f00";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const typing = () => /^(input|textarea|select)$/i.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
  const found = new Set(JSON.parse((() => { try { return localStorage.getItem("eggs") || "[]"; } catch (e) { return "[]"; } })()));
  const TOTAL = 17;
  function egg(id, msg) {
    const isNew = !found.has(id);
    found.add(id);
    try { localStorage.setItem("eggs", JSON.stringify([...found])); } catch (e) {}
    if (msg) toast(msg + (isNew ? `  🥚 ${found.size}/${TOTAL}` : ""));
  }

  // ------------------------------------------------ Effekte
  function layer(z = 9999) {
    const c = el("canvas", { style: `position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:${z}` });
    c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
    document.body.append(c);
    const ctx = c.getContext("2d"); ctx.scale(devicePixelRatio, devicePixelRatio);
    return [c, ctx];
  }

  function confetti(n = 160, x0, y0) {
    if (reduced) return;
    const [c, ctx] = layer();
    const cols = [ORANGE, "#ffb366", "#ffffff", "#1d4ed8", "#facc15", "#22c55e"];
    const ps = Array.from({ length: n }, () => ({
      x: x0 ?? Math.random() * innerWidth, y: y0 ?? -20 - Math.random() * innerHeight * 0.5,
      vx: (Math.random() - 0.5) * (x0 != null ? 14 : 3), vy: x0 != null ? -Math.random() * 14 - 2 : Math.random() * 3 + 2,
      r: Math.random() * 6 + 4, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.3, col: cols[Math.random() * cols.length | 0],
    }));
    const t0 = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of ps) {
        p.vy += 0.18; p.x += p.vx; p.y += p.vy; p.a += p.va; p.vx *= 0.99;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.col; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
      }
      if (t - t0 < 4500) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }

  function stars(x, y) {
    if (reduced) return;
    for (let i = 0; i < 14; i++) {
      const s = el("span", { style: `position:fixed;left:${x}px;top:${y}px;z-index:9999;pointer-events:none;color:${ORANGE};font-size:${14 + Math.random() * 14}px;transition:transform 1s cubic-bezier(.2,.8,.2,1),opacity 1s` }, "★");
      document.body.append(s);
      const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 90;
      requestAnimationFrame(() => { s.style.transform = `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px) rotate(${Math.random() * 360}deg)`; s.style.opacity = 0; });
      setTimeout(() => s.remove(), 1100);
    }
  }

  function matrix(ms = 7000) {
    const [c, ctx] = layer();
    c.style.pointerEvents = "auto"; c.style.cursor = "pointer";
    const chars = "expertKLEIN0123456789★€%".split(""), size = 18;
    const drops = Array(Math.ceil(innerWidth / size)).fill(0).map(() => Math.random() * -50);
    let stop = false; c.onclick = () => { stop = true; };
    const t0 = performance.now();
    (function frame(t) {
      ctx.fillStyle = "rgba(10,10,12,.12)"; ctx.fillRect(0, 0, innerWidth, innerHeight);
      ctx.font = `${size}px monospace`;
      drops.forEach((y, i) => {
        ctx.fillStyle = Math.random() < 0.05 ? "#fff" : ORANGE;
        ctx.fillText(chars[Math.random() * chars.length | 0], i * size, y * size);
        drops[i] = y * size > innerHeight && Math.random() > 0.975 ? 0 : y + 1;
      });
      if (!stop && t - t0 < ms) requestAnimationFrame(frame);
      else { c.style.transition = "opacity .6s"; c.style.opacity = 0; setTimeout(() => c.remove(), 600); }
    })(t0);
  }

  function snow() {
    if (reduced) return;
    const [c, ctx] = layer(5);
    const fl = Array.from({ length: 70 }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: Math.random() * 2.5 + 1, v: Math.random() + 0.4 }));
    (function frame() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.fillStyle = "rgba(255,255,255,.85)";
      for (const f of fl) { f.y += f.v; f.x += Math.sin(f.y / 30) * 0.4; if (f.y > innerHeight) { f.y = -5; f.x = Math.random() * innerWidth; } ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill(); }
      requestAnimationFrame(frame);
    })();
  }

  function fireworks() {
    if (reduced) return;
    for (let i = 0; i < 6; i++) setTimeout(() => confetti(60, innerWidth * (0.15 + Math.random() * 0.7), innerHeight * (0.3 + Math.random() * 0.3)), i * 600);
  }

  function barrelRoll() {
    document.body.animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: reduced ? 1 : 1400, easing: "cubic-bezier(.6,0,.3,1)" });
  }

  function disco(ms = 8000) {
    const st = el("style", {}, `header, .panel, .ops-tile, .dk-card { animation: eggDisco 1.2s linear infinite !important; } @keyframes eggDisco { to { filter: hue-rotate(360deg); } }`);
    document.head.append(st);
    setTimeout(() => st.remove(), ms);
  }

  // ------------------------------------------------ 1. Konami-Code
  const konami = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  let kpos = 0;
  // ------------------------------------------------ 2. Wörter tippen (außerhalb von Eingabefeldern)
  const WORDS = {
    expert: () => { stars(innerWidth / 2, innerHeight / 2); egg("expert", "Mit den besten Empfehlungen! ★"); },
    barrelroll: () => { barrelRoll(); egg("roll", "Wuuuusch! 🌀"); },
    matrix: () => { matrix(); egg("matrix", "Folge dem orangen Kaninchen … 🐇"); },
    disco: () => { disco(); egg("disco", "Disco-Modus! 🪩"); },
    kaffee: () => coffee(),
    snake: () => snakeGame(),
    benchy: () => { benchy(); },
    hallo: () => { egg("hallo", `Hallo zurück! 👋 Schön, dass du da bist.`); },
    danke: () => { confetti(80); egg("danke", "Gern geschehen! 🧡"); },
  };
  let typed = "";
  document.addEventListener("keydown", e => {
    if ($("#app")?.hidden) return;
    // Konami (geht auch in Feldern nicht – nur außerhalb)
    // im Video-Schnitt sind einzelne Tasten Kurzbefehle (S = Schneiden …) – dort keine Wörter auswerten
    const inEditor = typeof ED !== "undefined" && ED.visible;
    if (!typing() && !inEditor) {
      kpos = e.key === konami[kpos] || e.key.toLowerCase() === konami[kpos] ? kpos + 1 : (e.key === konami[0] ? 1 : 0);
      if (kpos === konami.length) { kpos = 0; confetti(220); egg("konami", "↑↑↓↓←→←→BA – Cheat aktiviert: unendlich gute Laune! 🎉"); }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        typed = (typed + e.key.toLowerCase()).slice(-20);
        for (const w in WORDS) if (typed.replace(/\s/g, "").endsWith(w)) { typed = ""; WORDS[w](); break; }
      }
    }
  }, true);

  // ------------------------------------------------ 3. Geheime Begriffe in der Menü-Suche
  const search = $("#menuSearch");
  const MENU_EGGS = { kaffee: "☕ Kaffeepause", coffee: "☕ Kaffeepause", snake: "🐍 Filament-Snake", spiel: "🐍 Filament-Snake",
    party: "🪩 Disco-Modus", disco: "🪩 Disco-Modus", matrix: "🟧 Matrix", "42": "🌌 Die Antwort", credits: "🎬 Abspann",
    eier: "🥚 Gefundene Easter Eggs", eggs: "🥚 Gefundene Easter Eggs" };
  const eggBtn = el("button", { class: "menu-egg", hidden: true, type: "button" });
  search?.closest(".menu-panel")?.append(eggBtn);
  const runMenuEgg = word => {
    setMenu(false);
    ({ kaffee: coffee, coffee, snake: snakeGame, spiel: snakeGame, party: () => { disco(); egg("disco", "Disco-Modus! 🪩"); }, disco: () => { disco(); egg("disco", "Disco-Modus! 🪩"); },
       matrix: () => { matrix(); egg("matrix", "Folge dem orangen Kaninchen … 🐇"); }, "42": answer, credits, eier: showFound, eggs: showFound })[word]();
  };
  search?.addEventListener("input", () => {
    const w = search.value.trim().toLowerCase();
    eggBtn.hidden = !MENU_EGGS[w];
    if (MENU_EGGS[w]) { eggBtn.textContent = MENU_EGGS[w] + " – geheim! ↵"; eggBtn.onclick = () => runMenuEgg(w); $("#menuEmpty").hidden = true; }
  });
  search?.addEventListener("keydown", e => {
    const w = search.value.trim().toLowerCase();
    if (e.key === "Enter" && MENU_EGGS[w]) { e.preventDefault(); e.stopImmediatePropagation(); runMenuEgg(w); }
  }, true);
  document.head.append(el("style", {}, `.menu-egg { display: block; width: 100%; margin-top: 8px; padding: 12px; border-radius: 10px; border: 1px dashed ${ORANGE};
    background: var(--accent-soft); color: var(--accent); font: inherit; font-weight: 700; cursor: pointer; animation: menu-in .2s ease both; }`));

  // ------------------------------------------------ 4. Logo 7× anklicken
  let logoClicks = 0, logoT = 0;
  document.querySelector(".bar img")?.addEventListener("click", e => {
    logoClicks = Date.now() - logoT < 600 ? logoClicks + 1 : 1; logoT = Date.now();
    e.target.animate([{ transform: "scale(1)" }, { transform: "scale(1.25) rotate(-8deg)" }, { transform: "scale(1)" }], { duration: 250 });
    if (logoClicks === 7) {
      logoClicks = 0;
      e.target.animate([{ transform: "rotate(0)" }, { transform: "rotate(720deg) scale(1.4)" }, { transform: "rotate(720deg)" }], { duration: 1200, easing: "ease-in-out" });
      stars(e.clientX, e.clientY);
      egg("logo", "Du hast das Logo schwindelig geklickt 😵‍💫");
    }
  });

  // ------------------------------------------------ 5. „Retail Demo“ dreimal anklicken: Abspann
  document.querySelector(".bar .brand")?.addEventListener("click", e => { if (e.detail === 3) credits(); });
  function credits() {
    const lines = ["RETAIL DEMO", "", "Idee & Laden", "expert Klein", "", "Programmiert mit", "viel Kaffee ☕ und Claude", "", "Besonderer Dank an", "alle Demo-Handys, die nie Pause machen",
      "den 3D-Drucker, der nachts weiterdruckt", "jeden Kunden, der „nur mal schauen“ wollte", "", "Mit den besten Empfehlungen ★"];
    const box = el("div", { style: "position:fixed;inset:0;z-index:9998;background:rgba(8,8,10,.92);overflow:hidden;cursor:pointer;color:#fff;text-align:center;font-size:22px" });
    const roll = el("div", { style: "position:absolute;left:0;right:0;top:100%;line-height:1.8" }, ...lines.map((l, i) => el("div", { style: i === 0 ? `font-size:44px;font-weight:800;color:${ORANGE}` : /^[A-ZÄÖÜ][a-zäöü]+( |$)/.test(l) && lines[i - 1] === "" ? `color:${ORANGE};font-size:16px;letter-spacing:.15em;text-transform:uppercase` : "" }, l || " ")));
    box.append(roll); document.body.append(box);
    const close = () => box.remove();
    box.onclick = close;
    roll.animate([{ transform: "translateY(0)" }, { transform: `translateY(-${innerHeight + lines.length * 40 + 200}px)` }], { duration: reduced ? 100 : 16000, easing: "linear" }).onfinish = close;
    egg("credits", "Abspann 🎬");
  }

  // ------------------------------------------------ 6. Hell/Dunkel-Knopf 7× schnell drücken
  let themeClicks = 0, themeT = 0;
  $("#themeBtn")?.addEventListener("click", () => {
    themeClicks = Date.now() - themeT < 700 ? themeClicks + 1 : 1; themeT = Date.now();
    if (themeClicks === 7) { themeClicks = 0; disco(5000); egg("theme", "An, aus, an, aus … Lichtorgel! 💡"); }
  });

  // ------------------------------------------------ 7. Kaffeepause
  function coffee() {
    const steam = el("div", { class: "egg-cup" }, el("span"), el("span"), el("span"));
    const left = el("b", { style: "font-size:28px;font-variant-numeric:tabular-nums" }, "5:00");
    let s = 300; const iv = setInterval(() => { s--; left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; if (s <= 0) { clearInterval(iv); left.textContent = "Weiter geht's! 💪"; } }, 1000);
    dialog("Kaffeepause ☕", [el("div", { style: "display:grid;justify-items:center;gap:12px;padding:10px" }, steam, left,
      el("p", { class: "muted", style: "text-align:center;margin:0" }, "Die Demo-Handys laufen auch ohne dich weiter. Versprochen."))], [["Pause beenden", "ok", "primary"]]).then(() => clearInterval(iv));
    egg("kaffee");
  }
  document.head.append(el("style", {}, `
    .egg-cup { position: relative; width: 90px; height: 70px; margin-top: 40px; background: ${ORANGE}; border-radius: 0 0 26px 26px; }
    .egg-cup::after { content: ""; position: absolute; right: -24px; top: 12px; width: 26px; height: 28px; border: 7px solid ${ORANGE}; border-left: 0; border-radius: 0 16px 16px 0; }
    .egg-cup span { position: absolute; bottom: 78px; width: 8px; height: 26px; border-radius: 8px; background: var(--muted); opacity: 0; animation: eggSteam 2s infinite; }
    .egg-cup span:nth-child(1) { left: 22px; } .egg-cup span:nth-child(2) { left: 41px; animation-delay: .6s; } .egg-cup span:nth-child(3) { left: 60px; animation-delay: 1.2s; }
    @keyframes eggSteam { 0% { opacity: 0; transform: translateY(10px) scaleY(.6); } 40% { opacity: .5; } 100% { opacity: 0; transform: translateY(-22px) scaleY(1.2); } }`));

  // ------------------------------------------------ 8. Die Antwort
  function answer() {
    dialog("Die Antwort", [el("p", { style: "font-size:64px;font-weight:800;text-align:center;margin:10px 0;color:var(--accent)" }, "42"),
      el("p", { class: "muted", style: "text-align:center" }, "… auf die Frage nach dem Leben, dem Universum und dem ganzen Rest. Die Frage nach dem besten Handy beantworten wir im Laden.")], [["Ah ja", "ok", "primary"]]);
    egg("42");
  }

  // ------------------------------------------------ 9. Filament-Snake (kleines Spiel)
  function snakeGame() {
    const N = 20, S = 18;
    const cv = el("canvas", { width: N * S, height: N * S, tabindex: 0, autofocus: true, style: "display:block;margin:0 auto;border-radius:10px;background:#15171c;max-width:100%;touch-action:none" });
    const score = el("b", {}, "0");
    let best = 0; try { best = +localStorage.getItem("eggSnake") || 0; } catch (e) {}
    const info = el("p", { class: "muted", style: "text-align:center;margin:8px 0 0" }, "Pfeiltasten oder Wischen. Sammle Filament-Rollen, ohne dich selbst zu verknoten. Rekord: ", el("span", {}, String(best)));
    const ctx = cv.getContext("2d");
    let snake, dir, nextDir, food, alive, timer;
    const reset = () => { snake = [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }]; dir = nextDir = { x: 1, y: 0 }; alive = true; score.textContent = "0"; place(); };
    const place = () => { do { food = { x: Math.random() * N | 0, y: Math.random() * N | 0 }; } while (snake.some(p => p.x === food.x && p.y === food.y)); };
    const draw = () => {
      ctx.fillStyle = "#15171c"; ctx.fillRect(0, 0, N * S, N * S);
      ctx.strokeStyle = "rgba(255,255,255,.04)";
      for (let i = 0; i <= N; i++) { ctx.beginPath(); ctx.moveTo(i * S, 0); ctx.lineTo(i * S, N * S); ctx.moveTo(0, i * S); ctx.lineTo(N * S, i * S); ctx.stroke(); }
      // Filament-Rolle
      const fx = food.x * S + S / 2, fy = food.y * S + S / 2;
      ctx.fillStyle = "#facc15"; ctx.beginPath(); ctx.arc(fx, fy, S / 2 - 1, 0, 7); ctx.fill();
      ctx.fillStyle = "#15171c"; ctx.beginPath(); ctx.arc(fx, fy, S / 5, 0, 7); ctx.fill();
      snake.forEach((p, i) => { ctx.fillStyle = i ? ORANGE : "#ffb366"; ctx.beginPath(); ctx.roundRect(p.x * S + 1, p.y * S + 1, S - 2, S - 2, 5); ctx.fill(); });
      if (!alive) {
        ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(0, 0, N * S, N * S);
        ctx.fillStyle = "#fff"; ctx.font = "bold 22px sans-serif"; ctx.textAlign = "center";
        ctx.fillText("Verknotet! 🧶", N * S / 2, N * S / 2 - 8); ctx.font = "14px sans-serif"; ctx.fillText("Leertaste / Tippen = nochmal", N * S / 2, N * S / 2 + 18);
      }
    };
    const step = () => {
      if (!alive) return;
      dir = nextDir;
      const h = { x: (snake[0].x + dir.x + N) % N, y: (snake[0].y + dir.y + N) % N };
      if (snake.some(p => p.x === h.x && p.y === h.y)) {
        alive = false;
        const sc = snake.length - 3;
        if (sc > best) { best = sc; try { localStorage.setItem("eggSnake", best); } catch (e) {} info.lastChild.textContent = String(best); }
      } else {
        snake.unshift(h);
        if (h.x === food.x && h.y === food.y) { score.textContent = String(snake.length - 3); place(); if (snake.length - 3 === 10) egg("snake10", "10 Rollen! Der Drucker ist versorgt 🧵"); }
        else snake.pop();
      }
      draw();
    };
    const turn = (x, y) => { if (x !== -dir.x || y !== -dir.y) nextDir = { x, y }; };
    const keys = e => {
      const m = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] }[e.key];
      if (m) { e.preventDefault(); e.stopPropagation(); turn(...m); }
      if (e.key === " " && !alive) { e.preventDefault(); reset(); }
    };
    let touch;
    cv.addEventListener("pointerdown", e => { touch = [e.clientX, e.clientY]; if (!alive) reset(); });
    cv.addEventListener("pointerup", e => {
      if (!touch) return;
      const dx = e.clientX - touch[0], dy = e.clientY - touch[1];
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 20) Math.abs(dx) > Math.abs(dy) ? turn(Math.sign(dx), 0) : turn(0, Math.sign(dy));
    });
    addEventListener("keydown", keys, true);
    reset(); draw();
    timer = setInterval(step, 120);
    dialog("🐍 Filament-Snake", [el("p", { style: "text-align:center;margin:0 0 8px" }, "Rollen: ", score), cv, info], [["Zurück an die Arbeit", "ok", "primary"]])
      .then(() => { clearInterval(timer); removeEventListener("keydown", keys, true); });
    egg("snake");
  }

  // ------------------------------------------------ 10. Benchy (3D-Druck-Klassiker)
  function benchy() {
    if (reduced) { egg("benchy", "⛵ Ein Benchy! Der Klassiker unter den Testdrucken."); return; }
    const b = el("div", { style: "position:fixed;bottom:12px;left:-80px;z-index:9999;font-size:48px;pointer-events:none" }, "⛵");
    document.body.append(b);
    b.animate([{ transform: "translateX(0) rotate(-4deg)" }, { transform: `translateX(${innerWidth / 2}px) rotate(4deg)` }, { transform: `translateX(${innerWidth + 160}px) rotate(-4deg)` }],
      { duration: 6000, easing: "ease-in-out" }).onfinish = () => b.remove();
    egg("benchy", "⛵ Ein Benchy! Der Klassiker unter den Testdrucken.");
  }
  // im Slicer: Datei mit „benchy“ im Namen hochgeladen
  addEventListener("change", e => { if (e.target.type === "file" && [...(e.target.files || [])].some(f => /benchy/i.test(f.name))) setTimeout(benchy, 800); }, true);

  // ------------------------------------------------ 11. Bildschirmschoner nach 5 Minuten ohne Bewegung
  let idleT, saver;
  const wake = () => {
    clearTimeout(idleT);
    if (saver) { saver.remove(); saver = null; }
    idleT = setTimeout(startSaver, 5 * 60_000);
  };
  ["pointermove", "keydown", "pointerdown", "wheel", "touchstart"].forEach(ev => addEventListener(ev, wake, { passive: true }));
  wake();
  function startSaver() {
    if (reduced || $("#app")?.hidden || document.querySelector("dialog[open]")) return;
    saver = el("div", { style: "position:fixed;inset:0;z-index:9997;background:#000" });
    const logo = el("img", { src: "/logo.svg", style: "position:absolute;width:120px;transition:filter .3s" });
    saver.append(logo); document.body.append(saver);
    let x = 50, y = 50, vx = 2.2, vy = 1.7, hue = 0;
    (function frame() {
      if (!saver) return;
      x += vx; y += vy;
      const W = innerWidth - 120, H = innerHeight - 120;
      let hitX = false, hitY = false;
      if (x < 0 || x > W) { vx = -vx; x = Math.max(0, Math.min(W, x)); hitX = true; hue += 70; }
      if (y < 0 || y > H) { vy = -vy; y = Math.max(0, Math.min(H, y)); hitY = true; hue += 70; }
      if (hitX && hitY) { confetti(120); egg("corner", "Genau in die Ecke! 📺"); }
      logo.style.left = x + "px"; logo.style.top = y + "px"; logo.style.filter = `hue-rotate(${hue}deg)`;
      requestAnimationFrame(frame);
    })();
  }

  // ------------------------------------------------ 12. Jahreszeiten
  const d = new Date(), md = (d.getMonth() + 1) * 100 + d.getDate();
  if (md >= 1201 && md <= 1226) setTimeout(snow, 1500);
  if (md === 1231 || md === 101) setTimeout(() => { fireworks(); egg("silvester", "Frohes neues Jahr! 🎆"); }, 2000);
  if (md === 1031) document.head.append(el("style", {}, ".bar .brand::after { content: ' 🎃'; }"));
  if (md === 401) document.head.append(el("style", {}, ".bar .brand::after { content: ' (heute ganz ernst gemeint)'; font-weight: 400; color: var(--muted); font-size: 12px; }"));

  // ------------------------------------------------ 13. Für Neugierige in der Entwicklerkonsole
  console.log("%c expert ★ Retail Demo ", `background:${ORANGE};color:#fff;font-size:20px;font-weight:800;padding:6px 10px;border-radius:6px`);
  console.log("%cDu schaust unter die Haube? 🔧 Tipp: Probier mal ↑↑↓↓←→←→BA auf der Seite – oder such im Menü nach „snake“.", "color:#888");

  // Fortschritt: Menü-Suche „eier“
  function showFound() {
    dialog("🥚 Easter Eggs", [el("p", { style: "font-size:40px;font-weight:800;text-align:center;margin:6px 0;color:var(--accent)" }, `${found.size} / ${TOTAL}`),
      el("p", { class: "muted", style: "text-align:center" }, found.size >= TOTAL ? "Alle gefunden – Respekt! 🏆" : "Es gibt noch mehr zu entdecken. Kleiner Tipp: Manche Wörter muss man einfach nur tippen …")], [["OK", "ok", "primary"]]);
  }
})();
