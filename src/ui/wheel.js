// Hue / saturation wheel for colour grading, Lightroom style.
//   drag            : hue and saturation together
//   Shift + drag    : saturation only (the point slides along its hue line)
//   Ctrl/Cmd + drag : hue only (the point goes around, saturation stays)
//   double click/tap: back to the centre
// The wheel fills its CSS box, so the same canvas serves the small desktop wheels and the big phone wheel.
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
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  cache.set(px, c);
  return c;
}
function hsv(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

/** hue 0..360, sat 0..1. onInput(hue, sat 0..100) while dragging, onCommit on release. */
export function createWheel({ onInput, onCommit }) {
  const cv = document.createElement('canvas'); cv.className = 'wheel';
  let hue = 0, sat = 0, dragging = false;
  function draw() {
    const dpr = Math.min(devicePixelRatio || 1, 2), px = Math.round(cv.clientWidth * dpr);
    if (px < 8) return;
    if (cv.width !== px) { cv.width = cv.height = px; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, px, px);
    g.drawImage(wheelBitmap(px), 0, 0);
    const r0 = px / 2, a = (hue * Math.PI) / 180, rr = sat * (r0 - 1);
    const x = r0 + Math.cos(a) * rr, y = r0 + Math.sin(a) * rr, hr = Math.max(4, Math.min(8, px / dpr / 18)) * dpr;
    if (dragging) {       // a faint guide while dragging: the spoke (what Shift moves along) and the ring (what Ctrl/Cmd moves around)
      g.lineWidth = dpr; g.strokeStyle = '#fff6';
      g.beginPath(); g.moveTo(r0, r0); g.lineTo(r0 + Math.cos(a) * (r0 - 1), r0 + Math.sin(a) * (r0 - 1)); g.stroke();
      g.beginPath(); g.arc(r0, r0, rr, 0, 7); g.stroke();
    }
    g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.fillStyle = sat > 0.02 ? `hsl(${hue} 90% 55%)` : '#0006';
    g.beginPath(); g.arc(x, y, hr, 0, 7); g.fill(); g.stroke();
  }
  function pick(e) {
    const r = cv.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const rad = r.width / 2, d = Math.hypot(dx, dy);
    if (e.shiftKey) {                         // saturation only: how far the pointer is along the current hue direction
      const a = (hue * Math.PI) / 180;
      sat = Math.min(1, Math.max(0, (dx * Math.cos(a) + dy * Math.sin(a)) / (rad - 1)));
    } else if (e.ctrlKey || e.metaKey) {      // hue only
      if (d > 3) hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    } else {
      sat = Math.min(1, d / (rad - 1));
      if (sat > 0.02) hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    }
    draw(); onInput(Math.round(hue) % 360, Math.round(sat * 100));
  }
  let lastTap = 0, lastX = 0, lastY = 0;
  const reset = () => { hue = 0; sat = 0; dragging = false; draw(); onInput(0, 0); onCommit(); };
  // double tap / double click resets the point to the centre. Detected by hand: iOS sends no dblclick for touches and zooms the page instead
  cv.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const now = performance.now();
    if (now - lastTap < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 30) { lastTap = 0; reset(); return; }
    lastTap = now; lastX = e.clientX; lastY = e.clientY;
    dragging = true; try { cv.setPointerCapture(e.pointerId); } catch {} pick(e);
  });
  cv.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());      // Ctrl+click is a right click on a Mac
  cv.addEventListener('pointermove', (e) => { if (dragging) pick(e); });
  const up = () => { if (dragging) { dragging = false; draw(); onCommit(); } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  new ResizeObserver(draw).observe(cv);
  return { el: cv, set(h, s) { hue = h; sat = s; draw(); }, redraw: draw };
}
