// Full-resolution export engine + dialog.
import { app, curItem, bus, renderState } from './app.js';
import { Renderer } from './gl.js';
import { makeGeo } from './geometry.js';
import { loadFull, lutLinear16, ONE } from './decode.js';
import { patchExif, injectExif } from './exif.js';
import { getLut } from './looks.js';
import { zip } from './zip.js';
import { patchImage, accessRgb16, accessRgba8 } from './spots.js';
import { displayP3Profile, injectIccJpeg, injectIccPng } from './icc.js';
import { tiff16 } from './tiff.js';
import { selectedItems } from './library.js';
import { modal, toast } from './ui/overlays.js';
import { lsGet, lsSet } from './store.js';

const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IOS_MAX_PIXELS = 16_000_000;     // Safari's canvas area limit is ~16.7 MP
const STRIP = 512;
const tick = () => new Promise((r) => setTimeout(r, 0));
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/tiff': 'tif' };
const OUT_SHARP = { none: 0, low: 0.25, standard: 0.5, high: 0.9 };

/**
 * Render one photo at full resolution (or resized). Returns { blob, name, w, h, note }.
 * opts: { format, quality 0..1, longEdge (0 = original), keepExif, rawQuality 1|3, suffix, colorSpace 'srgb'|'p3', outSharp 'none'|'low'|'standard'|'high' }
 */
export async function renderPhoto(item, opts, onProgress = () => {}, signal) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const er = new Renderer(canvas, { preserve: true });
  const check = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  try {
    const wantTiff = opts.format === 'image/tiff';
    if (wantTiff && !er.floatTargets) throw new Error('16-bit TIFF needs half-float rendering, which this browser / device does not offer');
    const wantP3 = opts.colorSpace === 'p3';
    const full = await loadFull(item.file, {
      quality: opts.rawQuality, maxDim: Math.min(16384, er.maxTex), outputColor: wantP3 ? 7 : 1,
      onStatus: (s) => onProgress(0.02, s),
    });
    check();
    const p3 = wantP3 && full.kind === 'raw';
    const FW = full.width, FH = full.height, A = FW / FH;
    const st = renderState(item);
    const geo = makeGeo(item.crop, A, false);
    er.setGeometry(geo);

    // output size
    const cw = geo.uSz[0] * FH, ch = geo.uSz[1] * FH;
    let scale = opts.longEdge ? Math.min(1, opts.longEdge / Math.max(cw, ch)) : 1;
    let note = full.reduced ? 'RAW decoded at reduced size (low memory). ' : '';
    if (wantP3 && !p3) note += 'Display P3 only applies to RAW files; this one is sRGB. ';
    if (IOS && !wantTiff && cw * ch * scale * scale > IOS_MAX_PIXELS) { scale = Math.sqrt(IOS_MAX_PIXELS / (cw * ch)); note += 'Capped to 16 MP on iOS. '; }
    if (Math.max(cw, ch) * scale > er.maxTex) scale = er.maxTex / Math.max(cw, ch);
    const outW = Math.max(1, Math.round(cw * scale)), outH = Math.max(1, Math.round(ch * scale));

    // pass 1 in strips (half-float targets for 16-bit output)
    er.beginFull(FW, FH, STRIP, { float: wantTiff });
    if (st.p.lut) { const l = await getLut(st.p.lut); if (l) er.setLut(l); }
    const gl = er.gl;
    let bmpTex = null;
    const spots = item.spots || [];
    if (full.kind === 'raw' && spots.length) { onProgress(0.06, 'Removing spots…'); patchImage(FW, FH, accessRgb16(full.rgb16, FW, full.colors || 3), spots); await tick(); }
    if (full.kind === 'bitmap') {
      bmpTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, bmpTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      let upload = full.bitmap;
      if (spots.length) {
        onProgress(0.06, 'Removing spots…');
        const c = document.createElement('canvas'); c.width = FW; c.height = FH;
        const g2 = c.getContext('2d', { willReadFrequently: true }); g2.drawImage(full.bitmap, 0, 0);
        const id = g2.getImageData(0, 0, FW, FH);
        patchImage(FW, FH, accessRgba8(id.data, FW), spots);
        upload = new Uint8Array(id.data.buffer);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, FW, FH, 0, gl.RGBA, gl.UNSIGNED_BYTE, upload);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      full.bitmap.close();
    }
    const buf = full.kind === 'raw' ? new Uint16Array(FW * STRIP * 4) : null;
    const ch3 = full.colors || 3;
    for (let y0 = 0; y0 < FH; y0 += STRIP) {
      check();
      const rows = Math.min(STRIP, FH - y0);
      let src;
      if (full.kind === 'raw') {
        const rgb = full.rgb16;
        for (let r = 0; r < rows; r++) {
          let i = (y0 + r) * FW * ch3, o = r * FW * 4;
          for (let x = 0; x < FW; x++, i += ch3, o += 4) {
            buf[o] = lutLinear16[rgb[i]]; buf[o + 1] = lutLinear16[rgb[i + 1]]; buf[o + 2] = lutLinear16[rgb[i + 2]]; buf[o + 3] = ONE;
          }
        }
        const t = Renderer.tex2d(gl, FW, rows, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, buf.subarray(0, FW * rows * 4));
        src = { tex: t, origin: [0, y0], size: [FW, rows] };
      } else src = { tex: bmpTex, origin: [0, 0], size: [FW, FH] };
      er.renderStrip(st, y0, rows, src);
      if (full.kind === 'raw') gl.deleteTexture(src.tex);
      onProgress(0.1 + 0.75 * ((y0 + rows) / FH), 'Rendering…');
      await tick();
    }
    full.rgb16 = null;
    er.endFull();
    check();
    const outSharp = OUT_SHARP[opts.outSharp || 'none'] || 0;
    const icc = p3 ? displayP3Profile() : null;

    if (wantTiff) {
      onProgress(0.88, 'Writing 16-bit TIFF…');
      const parts = [];
      await er.finishFullBands(st, outW, outH, async (rows16, top, n) => {
        parts.push(new Uint8Array(rows16.buffer, rows16.byteOffset, rows16.byteLength));
        onProgress(0.88 + 0.11 * ((top + n) / outH), 'Writing 16-bit TIFF…');
        check(); await tick();
      }, { outSharp });
      return { blob: tiff16(outW, outH, parts, icc), name: `${item.name}${opts.suffix}.tif`, w: outW, h: outH, note };
    }

    onProgress(0.93, 'Encoding…');
    er.finishFull(st, outW, outH, { outSharp });
    const type = opts.format;
    let blob = await new Promise((res) => canvas.toBlob(res, type, opts.quality));
    if (!blob) throw new Error('The browser could not encode this image (too large?)');
    if (blob.type === 'image/jpeg' && opts.keepExif && full.exifSeg) blob = await injectExif(blob, patchExif(full.exifSeg, outW, outH));
    if (icc && blob.type === 'image/jpeg') blob = await injectIccJpeg(blob, icc);
    else if (icc && blob.type === 'image/png') blob = await injectIccPng(blob, icc);
    else if (icc) note += 'Display P3 profile can only be embedded in JPEG, PNG and TIFF. ';
    const ext = EXT[blob.type] || 'jpg';
    if (type !== blob.type) note += `${type.split('/')[1].toUpperCase()} is not supported by this browser; saved as ${ext.toUpperCase()}. `;
    return { blob, name: `${item.name}${opts.suffix}.${ext}`, w: outW, h: outH, note };
  } finally {
    er.dispose();
  }
}

// ---------- export presets ----------
const BUILTIN_PRESETS = {
  'Web · 2048 px JPEG': { format: 'image/jpeg', quality: 0.85, size: '2048', keepExif: false, outSharp: 'standard', colorSpace: 'srgb', rawQuality: '1' },
  'Social · 1080 px JPEG': { format: 'image/jpeg', quality: 0.88, size: '1080', keepExif: false, outSharp: 'standard', colorSpace: 'srgb', rawQuality: '1' },
  'Full size · JPEG 92': { format: 'image/jpeg', quality: 0.92, size: '0', keepExif: true, outSharp: 'none', colorSpace: 'srgb', rawQuality: '1' },
  'Archive · 16-bit TIFF (P3)': { format: 'image/tiff', quality: 1, size: '0', keepExif: false, outSharp: 'none', colorSpace: 'p3', rawQuality: '3' },
};
const loadPresets = () => { try { return JSON.parse(lsGet('exportPresetsUser', '{}')); } catch { return {}; } };
const savePresets = (o) => lsSet('exportPresetsUser', JSON.stringify(o));

// ---------- dialog ----------
const SIZES = [['0', 'Original size'], ['6000', 'Long edge 6000 px'], ['4096', 'Long edge 4096 px'], ['3000', 'Long edge 3000 px'], ['2048', 'Long edge 2048 px'], ['1600', 'Long edge 1600 px'], ['1080', 'Long edge 1080 px']];

export function openExportDialog() {
  const cur = curItem();
  if (!cur) return;
  const selected = selectedItems();
  const prefs = JSON.parse(lsGet('exportPrefs', '{}'));
  const P = { format: 'image/jpeg', quality: 0.92, size: '0', keepExif: true, rawQuality: '1', suffix: '-edit', scope: 'cur', colorSpace: 'srgb', outSharp: 'none', ...prefs };
  let abort = null;
  const nSel = selected.length, nAll = app.items.length;

  modal('Export', (body, api) => {
    const row = (label, el) => { const r = document.createElement('div'); r.className = 'field-row'; const l = document.createElement('label'); l.textContent = label; r.append(l, el); body.append(r); return r; };
    const sel = (opts, val) => { const s = document.createElement('select'); for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; s.append(o); } s.value = val; return s; };

    // presets
    const presetSel = document.createElement('select');
    const fillPresets = (selected = '') => {
      presetSel.textContent = '';
      const mk = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; };
      presetSel.append(mk('', 'Last used'));
      const g1 = document.createElement('optgroup'); g1.label = 'Built-in';
      for (const n of Object.keys(BUILTIN_PRESETS)) g1.append(mk('b:' + n, n));
      presetSel.append(g1);
      const user = loadPresets();
      if (Object.keys(user).length) { const g2 = document.createElement('optgroup'); g2.label = 'Mine'; for (const n of Object.keys(user)) g2.append(mk('u:' + n, n)); presetSel.append(g2); }
      presetSel.value = selected;
    };
    fillPresets();
    const presetRow = row('Preset', presetSel);
    const saveP = document.createElement('button'); saveP.className = 'ib'; saveP.title = 'Save these settings as a preset'; saveP.textContent = '+'; saveP.style.fontSize = '18px';
    const delP = document.createElement('button'); delP.className = 'ib'; delP.title = 'Delete the selected preset'; delP.textContent = '×'; delP.style.fontSize = '18px';
    presetRow.append(saveP, delP);

    const scopeOpts = [['cur', `This photo (${cur.name})`]];
    if (nSel > 1) scopeOpts.push(['sel', `Selected photos (${nSel})`]);
    if (nAll > 1) scopeOpts.push(['all', `All photos (${nAll})`]);
    const scope = sel(scopeOpts, scopeOpts.some(([v]) => v === P.scope) ? P.scope : 'cur');
    row('Export', scope);
    const fmts = [['image/jpeg', 'JPEG'], ['image/png', 'PNG (lossless)'], ['image/webp', 'WebP']];
    if (!IOS) { const probe = new Renderer(document.createElement('canvas')); if (probe.floatTargets) fmts.push(['image/tiff', 'TIFF (16-bit)']); probe.dispose(); }
    const fmt = sel(fmts, fmts.some(([v]) => v === P.format) ? P.format : 'image/jpeg');
    row('Format', fmt);

    const qWrap = document.createElement('div'); qWrap.style.cssText = 'display:flex;align-items:center;gap:10px;flex:1';
    const q = document.createElement('input'); q.type = 'range'; q.className = 'lr'; q.min = 0.5; q.max = 1; q.step = 0.01; q.value = P.quality; q.style.flex = '1';
    const qv = document.createElement('span'); qv.style.cssText = 'width:34px;text-align:right;font:12px ui-monospace,monospace'; qv.textContent = Math.round(P.quality * 100);
    qWrap.append(q, qv);
    const qRow = row('Quality', qWrap);
    q.oninput = () => { qv.textContent = Math.round(q.value * 100); };

    const size = sel(SIZES, P.size); row('Size', size);
    const cspace = sel([['srgb', 'sRGB'], ['p3', 'Display P3 (RAW files)']], P.colorSpace); const csRow = row('Color space', cspace);
    const sharp = sel([['none', 'None'], ['low', 'Low'], ['standard', 'Standard'], ['high', 'High']], P.outSharp); row('Output sharpening', sharp);
    const rawQ = sel([['1', 'Standard (faster)'], ['3', 'High (slower, best detail)']], P.rawQuality);
    const rawRow = row('RAW demosaic', rawQ);
    const hasRaw = (list) => list.some((i) => /\.(raf|dng|cr2|cr3|nef|arw|orf|rw2|pef|srw)$/i.test(i.file.name));
    const targets = () => (scope.value === 'all' ? app.items : scope.value === 'sel' ? selected : [cur]);

    const meta = document.createElement('label'); meta.className = 'check';
    const metaCb = document.createElement('input'); metaCb.type = 'checkbox'; metaCb.checked = P.keepExif;
    meta.append(metaCb, 'Keep camera metadata (EXIF) in JPEG');
    body.append(meta);
    const suffix = document.createElement('input'); suffix.type = 'text'; suffix.value = P.suffix; suffix.maxLength = 24;
    row('File suffix', suffix);

    const showHide = () => {
      qRow.style.display = fmt.value === 'image/png' || fmt.value === 'image/tiff' ? 'none' : '';
      rawRow.style.display = hasRaw(targets()) ? '' : 'none';
      csRow.style.display = hasRaw(targets()) ? '' : 'none';
      meta.style.display = fmt.value === 'image/jpeg' ? '' : 'none';
    };
    fmt.onchange = showHide; scope.onchange = showHide; showHide();

    const current = () => ({ format: fmt.value, quality: +q.value, size: size.value, keepExif: metaCb.checked, rawQuality: rawQ.value, suffix: suffix.value, colorSpace: cspace.value, outSharp: sharp.value });
    const apply = (o) => {
      if (o.format && [...fmt.options].some((x) => x.value === o.format)) fmt.value = o.format;
      if (o.quality) { q.value = o.quality; qv.textContent = Math.round(o.quality * 100); }
      if (o.size !== undefined) size.value = o.size;
      if (o.keepExif !== undefined) metaCb.checked = o.keepExif;
      if (o.rawQuality) rawQ.value = o.rawQuality;
      if (o.colorSpace) cspace.value = o.colorSpace;
      if (o.outSharp) sharp.value = o.outSharp;
      showHide();
    };
    presetSel.onchange = () => {
      const v = presetSel.value; if (!v) return;
      apply(v.startsWith('b:') ? BUILTIN_PRESETS[v.slice(2)] : loadPresets()[v.slice(2)] || {});
    };
    saveP.onclick = () => {
      const name = prompt('Name for this export preset:');
      if (!name || !name.trim()) return;
      const u = loadPresets(); u[name.trim()] = current(); savePresets(u); fillPresets('u:' + name.trim());
    };
    delP.onclick = () => {
      const v = presetSel.value; if (!v.startsWith('u:')) { toast('Only your own presets can be deleted'); return; }
      const u = loadPresets(); delete u[v.slice(2)]; savePresets(u); fillPresets();
    };

    const prog = document.createElement('div'); prog.className = 'progress'; prog.hidden = true;
    const bar = document.createElement('i'); prog.append(bar); body.append(prog);
    const msg = document.createElement('div'); msg.className = 'm-msg'; body.append(msg);
    const out = document.createElement('div'); out.className = 'btn-row'; body.append(out);
    if (IOS) { const n = document.createElement('p'); n.className = 'hint'; n.textContent = 'On iPhone / iPad, exports are capped at about 16 megapixels (no TIFF).'; body.append(n); }

    api.start = async () => {
      const go = api.foot.querySelector('.primary');
      const list = targets();
      const c = current();
      const opts = { format: c.format, quality: c.quality, longEdge: +c.size, keepExif: c.keepExif, rawQuality: +c.rawQuality, suffix: c.suffix, colorSpace: c.colorSpace, outSharp: c.outSharp };
      lsSet('exportPrefs', JSON.stringify({ ...c, scope: scope.value }));
      abort = new AbortController();
      go.disabled = true; prog.hidden = false; out.textContent = '';
      for (const el of body.querySelectorAll('select,input,button')) el.disabled = true;
      const files = [], notes = [];
      try {
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          const r = await renderPhoto(it, opts, (f, s) => {
            bar.style.width = (((i + f) / list.length) * 100).toFixed(1) + '%';
            msg.textContent = `${list.length > 1 ? `Photo ${i + 1} of ${list.length} · ` : ''}${s}`;
          }, abort.signal);
          files.push({ name: r.name, blob: r.blob });
          if (r.note) notes.push(r.note);
          await tick();
        }
        bar.style.width = '100%';
        await deliver(files, out, msg, notes);
        go.textContent = 'Done';
        go.onclick = () => api.close();
        go.disabled = false;
      } catch (e) {
        if (e.name === 'AbortError') msg.textContent = 'Cancelled.';
        else { console.error(e); msg.textContent = 'Export failed: ' + (e.message || e); }
        for (const el of body.querySelectorAll('select,input,button')) el.disabled = false;
        go.disabled = false;
      }
      abort = null;
    };
  }, {
    buttons: [
      { label: 'Cancel', onClick: (m) => { if (abort) abort.abort(); else m.close(); } },
      { label: 'Export', primary: true, onClick: (m, btn) => { if (btn.textContent === 'Export') m.start(); } },
    ],
  });
}

async function deliver(files, out, msg, notes) {
  const total = files.reduce((a, f) => a + f.blob.size, 0);
  const sizeTxt = total > 1048576 ? (total / 1048576).toFixed(1) + ' MB' : Math.round(total / 1024) + ' KB';
  let blob, name;
  if (files.length === 1) { blob = files[0].blob; name = files[0].name; }
  else { msg.textContent = 'Packing ZIP…'; blob = await zip(files); name = `darkshed-export-${files.length}-photos.zip`; }
  msg.textContent = `${files.length === 1 ? name : `${files.length} photos`} · ${sizeTxt}${notes.length ? ' · ' + [...new Set(notes)].join('') : ''}`;
  const dl = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 20000); };
  const btn = (label, fn, primary) => { const b = document.createElement('button'); b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label; b.onclick = fn; out.append(b); };
  const shareFiles = files.map((f) => new File([f.blob], f.name, { type: f.blob.type }));
  const canShare = navigator.canShare?.({ files: shareFiles });
  if (canShare) btn(IOS ? 'Save / share…' : 'Share…', async () => { try { await navigator.share({ files: shareFiles }); } catch (e) { if (e.name !== 'AbortError') toast('Sharing failed, use Download'); } }, true);
  btn(files.length === 1 ? 'Download' : 'Download ZIP', dl, !canShare);
  if (!IOS && !('ontouchstart' in window)) dl();     // desktop: start the download straight away
}

bus.on('open-export', openExportDialog);
