// Kamerabilder in einem eigenen Thread holen und zeichnen – unabhängig von der 3D-Ansicht.
let canvas, ctx, seq = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

onmessage = e => {
  canvas = e.data.canvas;
  ctx = canvas.getContext('2d');
  loop();
};

async function loop() {
  for (;;) {
    try {
      const r = await fetch('api/frame?after=' + seq, { cache: 'no-store' });
      postMessage({ type: 'alive' });
      if (r.status !== 200) continue; // 204: 3 s lang kein neues Bild – einfach weiter warten
      seq = +r.headers.get('X-Seq');
      const bmp = await createImageBitmap(await r.blob());
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      postMessage({ type: 'frame' });
    } catch (err) {
      await sleep(500);
    }
  }
}
