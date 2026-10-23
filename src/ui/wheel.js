// Hue / saturation wheel for colour grading.
const cache = new Map();
function wheelBitmap(px) {
  if (cache.has(px)) return cache.get(px);
  const c = document.createElement('canvas'); c.width = c.height = px;
  const g = c.getContext('2d'), img = g.createImageData(px, px), r0 = px / 2;
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const dx = x + 0.5 - r0, dy = y + 0.5 - r0, d = Math.hypot(dx, dy) / (r0 - 1);
    const i = (y * px + x) * 4;
    if (d > 1) { img.data[i + 3] = 0; continue; }
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const [r, gg, b] = hsv(h, d, 0.92);
    img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b;
    img.data[i + 3] = d > 0.985 ? Math.max(0, (1 - d) / 0.015) * 255 : 255;
  }
  g.putImageData(img, 0, 0);
  cache.set(px, c);
  return c;
}
function hsv(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

/** hue 0..360, sat 0..1. onInput while dragging, onCommit on release. */
export function createWheel({ onInput, onCommit }) {
  const cv = document.createElement('canvas'); cv.className = 'wheel';
  let hue = 0, sat = 0;
  function draw() {
    const dpr = Math.min(devicePixelRatio || 1, 2), px = Math.round(168 * dpr);
    if (cv.width !== px) { cv.width = cv.height = px; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, px, px);
    g.drawImage(wheelBitmap(px), 0, 0);
    const r0 = px / 2, a = (hue * Math.PI) / 180, rr = sat * (r0 - 1);
    const x = r0 + Math.cos(a) * rr, y = r0 + Math.sin(a) * rr;
    g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.fillStyle = '#0006';
    g.beginPath(); g.arc(x, y, 6 * dpr, 0, 7); g.fill(); g.stroke();
  }
  function pick(e) {
    const r = cv.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const rad = r.width / 2;
    sat = Math.min(1, Math.hypot(dx, dy) / (rad - 1));
    if (sat > 0.02) hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    draw(); onInput(Math.round(hue) % 360, Math.round(sat * 100));
  }
  let down = false, lastTap = 0, lastX = 0, lastY = 0;
  const reset = () => { sat = 0; draw(); onInput(Math.round(hue), 0); onCommit(); };
  // double tap / double click resets the point to the centre. Detected by hand: iOS sends no dblclick for touches and zooms the page instead
  cv.addEventListener('pointerdown', (e) => {
    const now = performance.now();
    if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 30) { lastTap = 0; down = false; reset(); return; }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
    down = true; try { cv.setPointerCapture(e.pointerId); } catch {} pick(e);
  });
  cv.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  cv.addEventListener('pointermove', (e) => { if (down) pick(e); });
  const up = () => { if (down) { down = false; onCommit(); } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  draw();
  return { el: cv, set(h, s) { hue = h; sat = s; draw(); } };
}
