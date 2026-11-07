// RGB histogram or vectorscope (with skin tone line), both drawn from the small GPU readback.
import { lsGet, lsSet } from '../store.js';

const S = 128;                                     // vectorscope bins per axis
const SKIN = (123 * Math.PI) / 180;                // skin tone line, the usual vectorscope angle (between red and yellow)
// colour targets at 75%, like a video scope
const TARGETS = [['R', 191, 0, 0], ['Y', 191, 191, 0], ['G', 0, 191, 0], ['C', 0, 191, 191], ['B', 0, 0, 191], ['M', 191, 0, 191]];
// Rec.709 Cb / Cr of 8-bit gamma-encoded values, each in -0.5..0.5
const cbcr = (r, g, b) => { const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return [(b - y) / 1.8556 / 255, (r - y) / 1.5748 / 255]; };

export function createHistogram(canvas) {
  let data = null, scope = null, last = null, region = null, mode = lsGet('histMode', 'hist') === 'scope' ? 'scope' : 'hist';
  canvas.classList.toggle('scope', mode === 'scope');

  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (W && H && (canvas.width !== W || canvas.height !== H)) { canvas.width = W; canvas.height = H; }
    return [W, H, dpr];
  }

  function drawHist(g, W, H, dpr) {
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

  function drawScope(g, W, H, dpr) {
    const D = Math.min(W, H) - 4 * dpr, R = D / 2, cx = W / 2, cy = H / 2;
    const at = (cb, cr) => [cx + cb * D, cy - cr * D];          // +Cb right, +Cr up; 0.5 reaches the rim
    g.strokeStyle = '#2d2825'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.stroke();
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    if (scope) {   // traces: each bin in its own average colour, brightness by log count
      const img = new ImageData(S, S), lmax = Math.log1p(scope.max);
      for (let i = 0; i < S * S; i++) {
        const n = scope.n[i]; if (!n) continue;
        const k = Math.log1p(n) / lmax, r = scope.r[i] / n, gg = scope.g[i] / n, b = scope.b[i] / n;
        const m = Math.max(r, gg, b, 1), lift = 255 / m;           // show the hue at full brightness
        img.data.set([r * lift, gg * lift, b * lift, Math.round(60 + 195 * k)], i * 4);
      }
      const off = new OffscreenCanvas(S, S); off.getContext('2d').putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true; g.drawImage(off, cx - R, cy - R, D, D);
    }
    // skin tone line
    g.strokeStyle = 'rgba(232,200,170,.75)'; g.lineWidth = Math.max(1, dpr);
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(SKIN) * R, cy - Math.sin(SKIN) * R); g.stroke();
    // 75% targets
    const box = 4 * dpr; g.lineWidth = 1; g.font = `${9 * dpr}px ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const [t, r, gg, b] of TARGETS) {
      const [x, y] = at(...cbcr(r, gg, b));
      g.strokeStyle = `rgb(${r || 90},${gg || 90},${b || 90})`; g.strokeRect(x - box, y - box, 2 * box, 2 * box);
      const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1;
      g.fillStyle = '#8a817b'; g.fillText(t, x + (dx / l) * 10 * dpr, y + (dy / l) * 10 * dpr);
    }
  }

  function draw() {
    const [W, H, dpr] = size(); if (!W || !H) return;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    (mode === 'scope' ? drawScope : drawHist)(g, W, H, dpr);
  }
  new ResizeObserver(draw).observe(canvas);
  return {
    update(px) {
      const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), d = px.data;
      for (let i = 0, n = px.w * px.h * 4; i < n; i += 4) { r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++; }
      data = { r, g, b, n: px.w * px.h }; last = px;
      scope = mode === 'scope' ? bin(px) : null;
      draw();
    },
    clear() { data = null; scope = null; last = null; draw(); },
    redraw: draw,
    get mode() { return mode; },
    /** limit the vectorscope to { x0, y0, x1, y1 } (0..1 of the image), or null for the whole photo */
    setRegion(r) { region = r; if (mode === 'scope' && last) { scope = bin(last); draw(); } },
    setMode(m) {
      mode = m === 'scope' ? 'scope' : 'hist'; lsSet('histMode', mode);
      canvas.classList.toggle('scope', mode === 'scope');
      if (mode === 'scope' && !scope && last) scope = bin(last);
      draw();
    },
  };
  function bin(px) {
    const n = new Uint32Array(S * S), r = new Float32Array(S * S), g = new Float32Array(S * S), b = new Float32Array(S * S), d = px.data;
    let max = 1;
    const X0 = region ? Math.floor(region.x0 * px.w) : 0, X1 = region ? Math.ceil(region.x1 * px.w) : px.w;
    const Y0 = region ? Math.floor(region.y0 * px.h) : 0, Y1 = region ? Math.ceil(region.y1 * px.h) : px.h;
    for (let row = Y0; row < Y1; row++) for (let i = (row * px.w + X0) * 4, end = (row * px.w + X1) * 4; i < end; i += 4) {
      const [cb, cr] = cbcr(d[i], d[i + 1], d[i + 2]);
      const x = Math.min(S - 1, Math.max(0, ((cb + 0.5) * S) | 0)), y = Math.min(S - 1, Math.max(0, ((0.5 - cr) * S) | 0)), k = y * S + x;
      if (++n[k] > max) max = n[k];
      r[k] += d[i]; g[k] += d[i + 1]; b[k] += d[i + 2];
    }
    return { n, r, g, b, max };
  }
}
