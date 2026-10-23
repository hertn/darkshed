// Info pane: file and capture details.
import { app, curItem, bus } from '../app.js';
import { fmtExposure } from '../exif.js';
import { storedStatus, keepPrefs } from '../persist.js';

export function createInfoPanel() {
  const el = document.createElement('div'); el.className = 'pane'; el.dataset.pane = 'info';
  el.innerHTML = '<div class="pane-title">Info</div>';
  const dl = document.createElement('dl'); dl.className = 'info-grid';
  el.append(dl);
  const row = (k, v) => { if (v === undefined || v === null || v === '') return; const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); };
  const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
  function refresh() {
    dl.textContent = '';
    const it = curItem(), L = app.loaded;
    if (!it || !L) { row('', 'No photo open'); return; }
    const i = L.info, e = i.exif || {}, r = i.raw || {};
    row('File', it.file.name);
    row('Size', mb(it.file.size));
    row('Type', i.kind === 'RAW' ? 'RAW' : (it.file.type || 'Image'));
    row('Camera', i.camera || `${e.make || ''} ${e.model || ''}`.trim());
    row('Lens', e.lens);
    const exp = e.exposure ? fmtExposure(e.exposure) : (r.shutter ? fmtExposure(r.shutter) : '');
    const fn = e.fnumber || r.aperture, iso = e.iso || r.iso, fl = e.focal || r.focal;
    row('Exposure', [exp, fn ? `ƒ/${(+fn).toFixed(1)}` : '', iso ? `ISO ${iso}` : '', fl ? `${Math.round(fl)} mm` : ''].filter(Boolean).join('  ·  '));
    row('Captured', e.dateOriginal || e.date || (r.ts ? new Date(r.ts).toLocaleString() : ''));
    row('Dimensions', i.source.replace('×', ' × '));
    row('Working copy', `${L.width} × ${L.height}`);
    row('Decode', `${(i.decodeMs / 1000).toFixed(2)} s`);
    const slot = document.createElement('dd'), lab = document.createElement('dt'); lab.textContent = 'Stored copy'; slot.textContent = 'Checking…'; dl.append(lab, slot);
    storedStatus(it.key).then((st) => {
      if (!st.stored) slot.textContent = keepPrefs.keep ? 'Not stored on this device (yet)' : 'Not stored. Copies are switched off in Settings.';
      else slot.textContent = st.until ? `Kept on this device until ${new Date(st.until).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, or until you remove it. Opening or editing it resets the clock.` : 'Kept on this device until you remove it.';
    });
  }
  bus.on('select', refresh);
  refresh();
  return { el, impl: null, onEnter: refresh };
}
