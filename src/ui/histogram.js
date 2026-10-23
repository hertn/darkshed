// RGB histogram drawn from the small GPU readback.
export function createHistogram(canvas, infoEl) {
  let data = null;
  function draw() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.strokeStyle = '#2d2825'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo((W * i) / 4, 0); g.lineTo((W * i) / 4, H); g.stroke(); }
    if (!data) return;
    const chans = [[data.r, '255,72,72'], [data.g, '70,214,112'], [data.b, '84,140,255']];
    let max = 1;   // scale to the tallest interior bin so clipping spikes don't flatten everything
    for (const [c] of chans) for (let i = 2; i < 254; i++) max = Math.max(max, c[i]);
    g.globalCompositeOperation = 'lighter';
    for (const [c, rgb] of chans) {
      const sm = new Float32Array(256);
      for (let i = 0; i < 256; i++) sm[i] = (c[Math.max(0, i - 1)] + 2 * c[i] + c[Math.min(255, i + 1)]) / 4;
      g.beginPath(); g.moveTo(0, H);
      for (let i = 0; i < 256; i++) g.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(sm[i] / max)) * (H - 4));
      g.lineTo(W, H); g.closePath();
      g.fillStyle = `rgba(${rgb},.6)`; g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    const frac = (i) => Math.max(data.r[i], data.g[i], data.b[i]) / data.n;
    const tri = (x, c) => { g.fillStyle = c; g.beginPath(); g.moveTo(x, 3 * dpr); g.lineTo(x + (x ? -10 : 10) * dpr, 3 * dpr); g.lineTo(x, 13 * dpr); g.fill(); };
    if (frac(0) > 0.005) tri(0, '#5b9dff');
    if (frac(255) > 0.005) tri(W, '#ff5a5a');
  }
  new ResizeObserver(draw).observe(canvas);
  return {
    update(px) {
      const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), d = px.data;
      for (let i = 0, n = px.w * px.h * 4; i < n; i += 4) { r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++; }
      data = { r, g, b, n: px.w * px.h };
      draw();
    },
    clear() { data = null; draw(); },
    redraw: draw,
  };
}
