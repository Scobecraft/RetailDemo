"use strict";
// Themes: Partikel-Engine (Canvas) und eigene Eröffnungs-Szenen für Black Week, Weihnachten, Geburtstag.
// Zwei Ebenen: #fxBack hinter den Szenen (Schnee, Konfetti, Prozentzeichen),
// #fxFront davor für kurze Effekte (Funken, Feuerwerk, Konfetti-Kanonen, Goldstaub).
(function () {
  const THEMES = {
    standard: null,
    blackweek: { ribbon: "BLACK WEEK", claim: "Black Week – die besten Angebote des Jahres!" },
    weihnachten: { ribbon: "FROHE WEIHNACHTEN", claim: "Frohe Weihnachten und schöne Feiertage!" },
    geburtstag: { ribbon: "WIR FEIERN GEBURTSTAG!", claim: "Wir feiern Geburtstag!" },
    sonderangebot: { ribbon: "SONDERANGEBOT", claim: "Alles muss raus – nur solange der Vorrat reicht!" },
  };
  const SALE = ["#e30613", "#ffd400", "#ffffff", "#ff4d4d"];
  const GOLD = ["#ffe39a", "#f2cf7a", "#ffd166", "#fff4d0"];
  // Geburtstag: Gold, Champagner, Rosé-Gold, etwas Silber
  const FOIL = ["#d4af37", "#e9cf85", "#f6e7c1", "#c79a5b", "#e4c3a8", "#c0c4cc"];
  // Weihnachtsbaum aus Lichtern: warmweiß und gold, wenige eisblaue Akzente
  const TREE = ["#fff1c9", "#ffe39a", "#ffd27a", "#fff8e6", "#cfe3ff"];

  const back = document.getElementById("fxBack"), front = document.getElementById("fxFront");
  const bctx = back.getContext("2d"), fctx = front.getContext("2d");
  let W = 0, H = 0, DPR = 1;
  let name = "standard", running = false, raf = 0, last = 0, timers = [], now = 0;
  const ambient = [], effects = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    for (const c of [back, front]) { c.width = W * DPR; c.height = H * DPR; }
    bctx.setTransform(DPR, 0, 0, DPR, 0, 0); fctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  addEventListener("resize", resize);
  resize();

  // ---------------------------------------------------------------- Hintergrund-Partikel
  function spawnAmbient(initial) {
    const y0 = initial ? rnd(-H * .1, H) : null;
    if (name === "weihnachten") {
      if (Math.random() < .12) {
        // weiche Lichtreflexe (Bokeh), steigen langsam auf
        ambient.push({ k: "bokeh", x: rnd(0, W), y: initial ? rnd(0, H) : H + 60, r: rnd(18, 55), vy: -rnd(6, 16),
          a: rnd(.05, .14), c: pick(["255,226,160", "200,220,255", "255,240,210"]) });
      } else {
        const depth = Math.random();                   // 0 = weit weg, 1 = nah
        ambient.push({ k: "snow", x: rnd(0, W), y: y0 ?? rnd(-40, -10), r: .8 + depth * 3, vy: 14 + depth * 40,
          sway: rnd(10, 35), f: rnd(.25, .7), ph: rnd(0, 6.3), a: .3 + depth * .55, blur: depth < .3 });
      }
    } else if (name === "geburtstag") {
      if (Math.random() < .45) {
        // Champagner-Perlen steigen auf
        ambient.push({ k: "bubble", x: rnd(0, W), y: initial ? rnd(0, H) : H + 20, r: rnd(1.5, 5.5), vy: -rnd(30, 75),
          sway: rnd(4, 14), f: rnd(.8, 2), ph: rnd(0, 6.3), a: rnd(.25, .6) });
      } else {
        // goldenes Folien-Konfetti, schmal und langsam
        ambient.push({ k: "conf", x: rnd(0, W), y: y0 ?? rnd(-40, -10), w: rnd(3, 5), h: rnd(12, 20), vy: rnd(25, 55),
          sway: rnd(20, 50), f: rnd(.3, .7), ph: rnd(0, 6.3), rot: rnd(0, 6.3), vr: rnd(-1.5, 1.5), flip: rnd(0, 6.3), vf: rnd(2, 4.5), c: pick(FOIL), shine: true });
      }
    } else if (name === "sonderangebot") {
      ambient.push({ k: "tag", x: rnd(0, W), y: y0 ?? rnd(-80, -30), s: rnd(26, 58), vy: rnd(35, 80), sway: rnd(10, 35), f: rnd(.3, .8),
        ph: rnd(0, 6.3), rot: rnd(-.6, .6), vr: rnd(-.6, .6), c: Math.random() < .7 ? "#e30613" : "#ffd400", a: rnd(.25, .6) });
    } else if (name === "blackweek") {
      ambient.push({ k: "pct", x: rnd(0, W), y: initial ? rnd(0, H * 1.1) : H + 80, s: rnd(28, 120), vy: -rnd(25, 70),
        rot: rnd(-.4, .4), vr: rnd(-.3, .3), a: rnd(.06, .2) });
    }
  }
  const AMBIENT_COUNT = { weihnachten: 150, geburtstag: 110, blackweek: 26, sonderangebot: 22 };

  /** Preisschild (Anhänger mit Loch und "%") – für Hintergrund und Effekte */
  function drawTag(ctx, s, c) {
    const w = s, h = s * .62;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2 + 4); ctx.lineTo(w / 4, -h / 2); ctx.lineTo(w / 2, 0); ctx.lineTo(w / 4, h / 2); ctx.lineTo(-w / 2, h / 2 - 4); ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath(); ctx.arc(w / 4, 0, s * .07, 0, 6.3); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = c === "#ffd400" ? "#b0000b" : "#fff";
    ctx.font = `900 ${Math.round(h * .62)}px "Segoe UI", system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("%", -w * .08, 1);
  }

  function drawAmbient(dt, t) {
    const target = AMBIENT_COUNT[name] || 0;
    while (ambient.length < target) spawnAmbient(false);
    bctx.clearRect(0, 0, W, H);
    for (let i = ambient.length - 1; i >= 0; i--) {
      const p = ambient[i];
      p.y += p.vy * dt;
      if (p.k === "snow") {
        const x = p.x + Math.sin(t * p.f + p.ph) * p.sway;
        bctx.globalAlpha = p.a;
        const g = bctx.createRadialGradient(x, p.y, 0, x, p.y, p.r * (p.blur ? 2.2 : 1.4));
        g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
        bctx.fillStyle = g; bctx.beginPath(); bctx.arc(x, p.y, p.r * (p.blur ? 2.2 : 1.4), 0, 6.3); bctx.fill();
        if (p.y > H + 20) ambient.splice(i, 1);
      } else if (p.k === "conf") {
        p.rot += p.vr * dt; p.flip += p.vf * dt;
        const x = p.x + Math.sin(t * p.f + p.ph) * p.sway;
        const c = Math.cos(p.flip);
        bctx.save(); bctx.translate(x, p.y); bctx.rotate(p.rot); bctx.scale(1, c);
        // Folie glänzt, wenn sie zum Betrachter gedreht ist
        bctx.globalAlpha = p.shine ? .45 + .5 * Math.abs(c) : .85; bctx.fillStyle = p.c; bctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); bctx.restore();
        if (p.y > H + 30) ambient.splice(i, 1);
      } else if (p.k === "bubble") {
        const x = p.x + Math.sin(t * p.f + p.ph) * p.sway;
        bctx.globalAlpha = p.a; bctx.strokeStyle = "rgba(246,231,193,.9)"; bctx.lineWidth = 1;
        bctx.beginPath(); bctx.arc(x, p.y, p.r, 0, 6.3); bctx.stroke();
        bctx.fillStyle = "rgba(255,255,255,.8)"; bctx.beginPath(); bctx.arc(x - p.r * .35, p.y - p.r * .35, p.r * .25, 0, 6.3); bctx.fill();
        if (p.y < -20) ambient.splice(i, 1);
      } else if (p.k === "bokeh") {
        const g = bctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        g.addColorStop(0, `rgba(${p.c},${p.a})`); g.addColorStop(.7, `rgba(${p.c},${p.a * .6})`); g.addColorStop(1, `rgba(${p.c},0)`);
        bctx.globalAlpha = 1; bctx.fillStyle = g; bctx.beginPath(); bctx.arc(p.x, p.y, p.r, 0, 6.3); bctx.fill();
        if (p.y < -80) ambient.splice(i, 1);
      } else if (p.k === "tag") {
        p.rot += p.vr * dt;
        const x = p.x + Math.sin(t * p.f + p.ph) * p.sway;
        bctx.save(); bctx.translate(x, p.y); bctx.rotate(p.rot); bctx.globalAlpha = p.a; drawTag(bctx, p.s, p.c); bctx.restore();
        if (p.y > H + 80) ambient.splice(i, 1);
      } else if (p.k === "pct") {
        p.rot += p.vr * dt;
        bctx.save(); bctx.translate(p.x, p.y); bctx.rotate(p.rot); bctx.globalAlpha = p.a;
        bctx.fillStyle = "#ffd200"; bctx.font = `900 ${p.s}px "Segoe UI", system-ui, sans-serif`; bctx.textAlign = "center";
        bctx.fillText("%", 0, 0); bctx.restore();
        if (p.y < -150) ambient.splice(i, 1);
      }
    }
    bctx.globalAlpha = 1;
    if (name === "blackweek") drawStreaks(t);
  }

  // Black Week: gelegentliche gelbe Lichtstreifen quer über den Hintergrund
  function drawStreaks(t) {
    const phase = (t % 5) / 5;
    if (phase > .25) return;
    const x = -W * .3 + phase / .25 * W * 1.6;
    const g = bctx.createLinearGradient(x - 220, 0, x + 220, 0);
    g.addColorStop(0, "rgba(255,210,0,0)"); g.addColorStop(.5, "rgba(255,210,0,.10)"); g.addColorStop(1, "rgba(255,210,0,0)");
    bctx.save(); bctx.translate(W / 2, H / 2); bctx.rotate(-.35); bctx.translate(-W / 2, -H / 2);
    bctx.fillStyle = g; bctx.fillRect(x - 220, -H, 440, H * 3); bctx.restore();
  }

  // ---------------------------------------------------------------- Effekte vorne
  function drawEffects(dt) {
    fctx.clearRect(0, 0, W, H);
    fctx.globalCompositeOperation = "lighter";
    for (let i = effects.length - 1; i >= 0; i--) {
      const p = effects[i];
      p.life -= dt;
      if (p.life <= 0) { if (p.onEnd) p.onEnd(p); effects.splice(i, 1); continue; }
      p.vx *= Math.pow(p.drag ?? .98, dt * 60); p.vy *= Math.pow(p.drag ?? .98, dt * 60);
      p.vy += (p.g ?? 0) * dt;
      const px = p.x, py = p.y;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const a = Math.min(1, p.life / (p.fade ?? .6));
      if (p.k === "spark" || p.k === "rocket") {
        fctx.globalAlpha = a; fctx.strokeStyle = p.c; fctx.lineWidth = p.w ?? 2.2; fctx.lineCap = "round";
        const trail = p.k === "rocket" ? .5 : 2.5;      // Raketen nur mit kurzer Leuchtspur
        fctx.beginPath(); fctx.moveTo(px - (p.x - px) * trail, py - (p.y - py) * trail); fctx.lineTo(p.x, p.y); fctx.stroke();
      } else if (p.k === "light") {
        // Baum-Licht: erscheint verzögert, funkelt, vorne heller als hinten
        // Alter nach echter Zeit, damit der Baum auch bei niedriger Bildrate pünktlich steht
        p.age = now - (p.t0 ??= now);
        if (p.age < p.delay) continue;
        const appear = Math.min(1, (p.age - p.delay) / .35);
        const tw = .7 + .3 * Math.sin(p.age * p.tw + p.ph);
        fctx.globalAlpha = a * appear * tw * p.depth;
        const g = fctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3);
        g.addColorStop(0, p.c); g.addColorStop(.25, p.c); g.addColorStop(1, "rgba(255,220,150,0)");
        fctx.fillStyle = g; fctx.beginPath(); fctx.arc(p.x, p.y, p.r * 3, 0, 6.3); fctx.fill();
      } else if (p.k === "topstar") {
        p.age = now - (p.t0 ??= now);
        if (p.age < p.delay) continue;
        const s = Math.min(1, (p.age - p.delay) / .6), pulse = 1 + .08 * Math.sin(p.age * 3);
        fctx.globalAlpha = a * s;
        const g = fctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        g.addColorStop(0, "rgba(255,240,200,.9)"); g.addColorStop(1, "rgba(255,210,120,0)");
        fctx.fillStyle = g; fctx.beginPath(); fctx.arc(p.x, p.y, p.r * 4 * pulse, 0, 6.3); fctx.fill();
        fctx.fillStyle = "#fff4d6"; drawStar(fctx, p.x, p.y, p.r * s * pulse, p.r * .32 * s);
      } else if (p.k === "dust") {
        const tw = .6 + .4 * Math.sin(p.life * 18 + p.ph);
        fctx.globalAlpha = a * tw; fctx.fillStyle = p.c;
        drawStar(fctx, p.x, p.y, p.r * tw, p.r * .35);
      } else if (p.k === "tag") {
        fctx.globalCompositeOperation = "source-over";
        p.rot += p.vr * dt;
        fctx.save(); fctx.translate(p.x, p.y); fctx.rotate(p.rot); fctx.globalAlpha = a; drawTag(fctx, p.s, p.c); fctx.restore();
        fctx.globalCompositeOperation = "lighter";
      } else if (p.k === "conf") {
        fctx.globalCompositeOperation = "source-over";
        p.rot += p.vr * dt; p.flip += p.vf * dt;
        fctx.save(); fctx.translate(p.x, p.y); fctx.rotate(p.rot); fctx.scale(1, Math.cos(p.flip));
        fctx.globalAlpha = a; fctx.fillStyle = p.c; fctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); fctx.restore();
        fctx.globalCompositeOperation = "lighter";
      }
    }
    fctx.globalAlpha = 1; fctx.globalCompositeOperation = "source-over";
  }

  function drawStar(ctx, x, y, R, r) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = i * Math.PI / 4, rad = i % 2 ? r : R;
      ctx.lineTo(x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);
    }
    ctx.closePath(); ctx.fill();
  }

  function sparks(x, y, n, colors, speed = 520, opts = {}) {
    for (let i = 0; i < n; i++) {
      const ang = rnd(0, Math.PI * 2), v = rnd(.25, 1) * speed;
      effects.push({ k: "spark", x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, g: opts.g ?? 260, drag: .955,
        life: rnd(.7, 1.5), fade: .7, c: pick(colors), w: rnd(1.5, 3) });
    }
  }
  function firework(x, y, colors) {
    // Rakete steigt auf und zerplatzt
    effects.push({ k: "rocket", x, y: H + 10, vx: rnd(-40, 40), vy: -Math.sqrt(2 * 380 * (H + 10 - y)), g: 380, drag: 1,
      life: Math.sqrt(2 * (H + 10 - y) / 380), fade: .01, c: "#fff3c4", w: 2.5,
      onEnd: p => sparks(p.x, p.y, 110, [pick(colors), pick(colors), "#ffffff"], 430, { g: 120 }) });
  }
  /** Weihnachtsbaum aus Lichtpunkten: Spirale um einen Kegel, baut sich von oben nach unten auf */
  function lightTree(cx, top, h, life = 6.4) {
    const n = 380, turns = 8.5;
    for (let i = 0; i < n; i++) {
      const t = i / n, ang = t * turns * Math.PI * 2;
      const radius = (.05 + t * .95) * h * .42;
      const depth = .45 + .55 * (Math.sin(ang) * .5 + .5);          // vorne heller
      effects.push({ k: "light", x: cx + Math.cos(ang) * radius + rnd(-3, 3), y: top + t * h + Math.sin(ang) * h * .025,
        vx: 0, vy: 0, g: 0, drag: 1, life, fade: .8, delay: .3 + t * 1.8, r: rnd(1.6, 3.4) * (.7 + depth * .5),
        depth, tw: rnd(2, 6), ph: rnd(0, 6.3), c: pick(TREE) });
    }
    effects.push({ k: "topstar", x: cx, y: top - h * .03, vx: 0, vy: 0, g: 0, drag: 1, life, fade: .8, delay: .15, r: h * .055 });
  }
  function tagBurst(x, y, n, speed = 900) {
    for (let i = 0; i < n; i++) {
      const ang = rnd(0, Math.PI * 2), v = rnd(.3, 1) * speed;
      effects.push({ k: "tag", x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - 200, g: 700, drag: .97, life: rnd(1.6, 2.8), fade: .6,
        s: rnd(30, 64), rot: rnd(-1, 1), vr: rnd(-6, 6), c: Math.random() < .65 ? "#e30613" : "#ffd400" });
    }
  }
  /** feiner Goldglanz: Funken ohne Schwerkraft, langsam verglühend */
  function glitter(x, y, n = 60) {
    for (let i = 0; i < n; i++) {
      const ang = rnd(0, Math.PI * 2), v = rnd(40, 260);
      effects.push({ k: "dust", x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, g: 30, drag: .96, life: rnd(1.4, 2.8), fade: 1.2,
        r: rnd(2.5, 6), ph: rnd(0, 6), c: pick(GOLD) });
    }
  }
  function goldDust(cx, cy, rw, rh, n = 70) {
    for (let i = 0; i < n; i++) {
      effects.push({ k: "dust", x: cx + rnd(-rw, rw), y: cy + rnd(-rh, rh), vx: rnd(-20, 20), vy: rnd(-60, -15), g: 0, drag: .99,
        life: rnd(1.2, 2.6), fade: 1, r: rnd(3, 8), ph: rnd(0, 6), c: pick(GOLD) });
    }
  }
  const later = (ms, fn) => timers.push(setTimeout(() => { if (running) fn(); }, ms));

  // ---------------------------------------------------------------- Schleife
  function frame(ts) {
    const dt = Math.min(.05, (ts - last) / 1000 || 0); last = ts; now = ts / 1000;
    drawAmbient(dt, ts / 1000);
    drawEffects(dt);
    raf = running ? requestAnimationFrame(frame) : 0;
  }

  // ---------------------------------------------------------------- Christbaumkugeln (Weihnachten)
  function garland() {
    const el = document.getElementById("garland");
    if (name !== "weihnachten") { el.replaceChildren(); el.hidden = true; return; }
    el.hidden = false;
    // Kugeln an Fäden vom oberen Rand, sanft schwingend; Platz für Logo links und Eckband rechts lassen
    const balls = [
      // Mitte frei für den Stern des Lichterbaums, rechts frei für das Eckband
      // links frei für das Logo, Mitte für den Stern des Lichterbaums, rechts für das Eckband
      { x: 32, len: 9, r: 1.7, c: ["#f6e2a6", "#c99a3c"] }, { x: 37.5, len: 15, r: 2.2, c: ["#e9edf5", "#9aa4b5"] },
      { x: 43, len: 7, r: 1.5, c: ["#d9475a", "#7a1020"] }, { x: 56, len: 12, r: 2.0, c: ["#f6e2a6", "#c99a3c"] },
      { x: 62, len: 6, r: 1.4, c: ["#e9edf5", "#9aa4b5"] }, { x: 67.5, len: 10, r: 1.8, c: ["#d9475a", "#7a1020"] },
    ];
    el.innerHTML = balls.map((b, i) => `<div class="bauble" style="left:${b.x}vw;--len:${b.len}vh;--r:${b.r}vw;animation-delay:-${(i * .7).toFixed(1)}s;animation-duration:${(3.6 + i % 3 * .7).toFixed(1)}s">
      <i class="thread"></i><svg viewBox="0 0 40 46"><defs><radialGradient id="bg${i}" cx="35%" cy="35%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".9"/>
      <stop offset=".18" stop-color="${b.c[0]}"/><stop offset="1" stop-color="${b.c[1]}"/></radialGradient></defs>
      <rect x="15" y="0" width="10" height="7" rx="1.5" fill="#c9a24a"/><circle cx="20" cy="26" r="19" fill="url(#bg${i})"/>
      <path d="M6 22 Q20 30 34 22" stroke="rgba(255,255,255,.35)" stroke-width="1.2" fill="none"/></svg></div>`).join("");
  }

  // ---------------------------------------------------------------- Eröffnungs-Szenen
  const esc = s => escapeHtml(s);
  function scene(vm) {
    const store = vm.store_name || "";
    if (name === "blackweek") {
      const tape = "BLACK WEEK ★ JETZT ZUSCHLAGEN ★ ".repeat(8);
      return `<section class="scene tscene bw"><div class="flash"></div>
        <div class="tape t1"><div class="track">${tape}${tape}</div></div>
        <div class="tape t2"><div class="track">${tape}${tape}</div></div>
        <div class="bw-inner"><div class="bw-title"><span class="w1" data-t="BLACK">BLACK</span><span class="w2" data-t="WEEK">WEEK</span></div>
        <div class="bw-sub">Die besten Angebote des Jahres${store ? " bei " + esc(store) : ""}</div></div>
        <div class="bw-stamp"><svg viewBox="0 0 100 100"><defs><path id="bwc" d="M50 50 m-36 0 a36 36 0 1 1 72 0 a36 36 0 1 1 -72 0"/></defs>
          <text><textPath href="#bwc">ANGEBOTE ★ ANGEBOTE ★ ANGEBOTE ★</textPath></text></svg><b>%</b></div></section>`;
    }
    if (name === "sonderangebot") {
      const pts = Array.from({ length: 32 }, (_, i) => { const r = i % 2 ? 40 : 50, a = i * Math.PI / 16;
        return `${(50 + Math.cos(a) * r).toFixed(1)},${(50 + Math.sin(a) * r).toFixed(1)}`; }).join(" ");
      return `<section class="scene tscene sale"><div class="sale-rays"></div>
        <div class="sale-burst"><svg viewBox="0 0 100 100"><polygon points="${pts}"/></svg><div class="txt">ALLES<br>MUSS<br>RAUS!</div></div>
        <div class="sale-stamp"><span>SONDER</span><span>ANGEBOT</span></div>
        <div class="sale-sub">Nur solange der Vorrat reicht${store ? " – bei " + esc(store) : ""}!</div></section>`;
    }
    if (name === "weihnachten") {
      // Baum aus Lichtern wird auf der Effekt-Ebene gezeichnet; hier nur Schrift und Platzhalter
      const word = (w, d) => [...w].map((ch, i) => `<span style="animation-delay:${(d + i * .06).toFixed(2)}s">${esc(ch)}</span>`).join("");
      return `<section class="scene tscene xmas"><div class="xm-glow"></div><div class="xm-tree-space"></div>
        <h1 class="xm-title">${word("Frohe Weihnachten", 1.6)}</h1>
        <div class="xm-line"></div>
        <div class="xm-sub">und schöne Feiertage${store ? " wünscht " + esc(store) : ""}</div></section>`;
    }
    if (name === "geburtstag") {
      const word = (w, d) => [...w].map((ch, i) => ch === " " ? " " : `<span style="animation-delay:${(d + i * .05).toFixed(2)}s">${esc(ch)}</span>`).join("");
      return `<section class="scene tscene bday">
        <svg class="bd-frame" viewBox="0 0 1000 560" preserveAspectRatio="none"><rect x="8" y="8" width="984" height="544" rx="18" pathLength="100"/>
          <rect x="26" y="26" width="948" height="508" rx="12" pathLength="100"/></svg>
        <div class="bd-kicker">${esc(store || "Jubiläum")}</div>
        <div class="bd-orn"><i></i><b>✦</b><i></i></div>
        <h1 class="bd-title"><span class="ln">${word("Wir feiern", .9)}</span><span class="ln">${word("Geburtstag!", 1.35)}</span></h1>
        <div class="bd-sub">Feier mit uns – mit besonderen Geburtstagsangeboten</div></section>`;
    }
    return "";
  }

  /** Effekte passend zur gerade gezeigten Szene auslösen */
  function onScene(kind) {
    if (!running || name === "standard") return;
    for (const t of timers) clearTimeout(t);
    timers = [];
    // Lichterbaum und noch fliegende Raketen gehören nur zur vorigen Szene
    for (let i = effects.length - 1; i >= 0; i--) if (["light", "topstar", "rocket"].includes(effects[i].k)) effects.splice(i, 1);
    const cx = W / 2, cy = H / 2;
    if (kind === "theme") {
      if (name === "sonderangebot") {
        later(600, () => tagBurst(W * .36, H * .4, 22, 700));
        later(1450, () => { tagBurst(W * .6, H * .58, 30, 1100); sparks(W * .6, H * .58, 80, SALE, 700); });
        later(2600, () => tagBurst(W * .12, H * .2, 24, 800));
      } else if (name === "blackweek") {
        later(420, () => sparks(cx - W * .14, cy - H * .06, 120, ["#ffd200", "#ffe766", "#ffffff", "#ff3b30"], 760));
        later(780, () => sparks(cx + W * .14, cy + H * .02, 120, ["#ffd200", "#ffe766", "#ffffff"], 760));
        later(1500, () => sparks(W * .82, H * .72, 60, ["#ffd200", "#ffffff"], 520));
      } else if (name === "weihnachten") {
        lightTree(cx, H * .1, H * .5);
        later(2300, () => glitter(cx, H * .1, 70));
        later(3000, () => goldDust(cx, H * .7, W * .25, H * .05, 60));
      } else if (name === "geburtstag") {
        later(1200, () => glitter(cx, cy - H * .05, 90));
        later(2200, () => firework(W * .2, H * .2, FOIL));
        later(2900, () => firework(W * .8, H * .22, FOIL));
        later(3800, () => firework(W * .5, H * .14, ["#f6e7c1", "#d4af37", "#ffffff"]));
      }
    } else if (kind === "brand") {
      if (name === "geburtstag") later(900, () => glitter(cx, cy - H * .1, 70));
      if (name === "weihnachten") later(900, () => goldDust(cx, cy, W * .25, H * .15, 70));
      if (name === "blackweek") later(500, () => sparks(cx, cy - H * .1, 90, ["#ffd200", "#ffffff"], 600));
      if (name === "sonderangebot") later(700, () => tagBurst(cx, cy - H * .1, 30, 800));
    } else if (kind === "specs") {
      // wenn das Preisschild aufploppt (ca. 1,3 s), links unten
      const px = W * .17, py = H * .62;
      if (name === "geburtstag") later(1400, () => glitter(px, py, 60));
      if (name === "weihnachten") later(1400, () => goldDust(px, py, 120, 50, 60));
      if (name === "blackweek") later(1400, () => sparks(px, py, 70, ["#ffd200", "#ffffff"], 560));
      if (name === "sonderangebot") later(1400, () => tagBurst(px, py, 22, 650));
    }
  }

  window.Theme = {
    info: (vm) => THEMES[vm && vm.theme] || null,
    /** Theme setzen (Farben über body[data-theme], Partikel, Lichterkette) */
    apply(vm) {
      const next = vm && THEMES[vm.theme] !== undefined ? vm.theme : "standard";
      if (next === name && document.body.dataset.theme === next) return;
      name = next;
      document.body.dataset.theme = name;
      ambient.length = 0; effects.length = 0;
      for (let i = 0; i < (AMBIENT_COUNT[name] || 0); i++) spawnAmbient(true);
      garland();
    },
    hasScene: () => name !== "standard",
    scene, onScene,
    resume() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); },
    pause() { running = false; cancelAnimationFrame(raf); for (const t of timers) clearTimeout(t); timers = []; effects.length = 0; fctx.clearRect(0, 0, W, H); },
  };
})();
