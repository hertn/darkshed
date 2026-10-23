// dev-only: ?test=<img>[,<img2>…]&p=<json params>&off=<json ids>&tool=<id>&zoom=<n>&name=<out>
// Loads images, applies state, then posts a screenshot of the canvas + overlay and a log to the dev server.
import { app, curItem, changed, commit, bus, renderState } from './app.js';
import * as lib from './library.js';
import { canvas, readbackNow } from './viewport.js';

const q = new URLSearchParams(location.search);
if (q.get('test') || q.get('after')) {
  const name = q.get('name') || 'shot';
  const log = [];
  const hold = null; void hold;
  const post = (body, suffix = '') => fetch('/__shot?name=' + name + suffix, { method: 'POST', body });
  addEventListener('error', (e) => log.push('error: ' + e.message));
  addEventListener('unhandledrejection', (e) => log.push('rejection: ' + (e.reason?.stack || e.reason?.message || e.reason)));
  const ce = console.error; console.error = (...a) => { log.push(a.join(' ')); ce(...a); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    try {
      const files = [];
      for (const path of (q.get('test') || '').split(',').filter(Boolean)) {
        const blob = await (await fetch(path)).blob();
        files.push(new File([blob], path.split('/').pop(), { type: blob.type, lastModified: 1 }));
      }
      if (files.length) await lib.addFiles(files); else await new Promise((r) => setTimeout(r, +q.get('after') || 4000));   // 'after': just run against whatever was restored
      const it = curItem();
      if (q.get('p')) { Object.assign(it.params, JSON.parse(q.get('p'))); }
      if (q.get('off')) it.off = new Set(JSON.parse(q.get('off')));
      bus.emit('sync-ui');
      if (q.get('tool')) { window.__app.setToolId(q.get('tool')); await sleep(100); }
      if (q.get('script')) { await new Function('ctx', `return (async()=>{${q.get('script')}})()`)({ app, it: curItem(), lib, bus, changed, commit, sleep, window, log: (...a) => log.push('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }); }
      if (q.get('export')) {
        const { renderPhoto } = await import('./export.js');
        const opts = { format: 'image/jpeg', quality: 0.9, longEdge: 0, keepExif: true, rawQuality: 1, suffix: '-edit', ...JSON.parse(q.get('export')) };
        const t0 = performance.now(); let last = '';
        const r = await renderPhoto(curItem(), opts, (f, s) => { if (s !== last) { last = s; log.push(`  progress ${(f * 100).toFixed(0)}% ${s} @${((performance.now() - t0) / 1000).toFixed(1)}s`); } });
        let bmp = null, d = new Uint8ClampedArray(256), mid = [0, 0, 0, 0];
        try { bmp = await createImageBitmap(r.blob); const c = document.createElement('canvas'); c.width = 8; c.height = 8; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, 8, 8); d = g.getImageData(0, 0, 8, 8).data; mid = g.getImageData(4, 4, 1, 1).data; } catch { /* not decodable by the browser (e.g. TIFF) */ }
        let sr = 0, sg = 0, sb = 0; for (let i = 0; i < d.length; i += 4) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
        log.push(`export: ${r.name} ${r.w}x${r.h} ${(r.blob.size / 1024) | 0}KB ${r.blob.type} in ${((performance.now() - t0) / 1000).toFixed(1)}s avg(${(sr / 64) | 0},${(sg / 64) | 0},${(sb / 64) | 0}) mid(${[...mid].slice(0, 3)}) note="${r.note}"`);
        // EXIF presence
        const ab = new Uint8Array(await r.blob.arrayBuffer()); const { extractExif, parseExif } = await import('./exif.js');
        const ex = extractExif(ab); log.push('exif in output: ' + JSON.stringify(parseExif(ex)));
        if (q.get('save')) {
          const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(new Blob([r.blob], { type: 'application/octet-stream' })); });
          await fetch('/__shot?name=' + name + '-out&ext=' + q.get('save'), { method: 'POST', body: data });
        }
        if (q.get('showexport') && bmp) { const big = document.createElement('canvas'); big.width = bmp.width; big.height = bmp.height; big.getContext('2d').drawImage(bmp, 0, 0); window.__exportPreview = big; }
      }
      changed({ edit: true, geo: true });
      await sleep(400);
      readbackNow();
      await sleep(600);
      { const r = app.renderer, st = renderState(curItem());
        const oi = app.tool === 'mask' && curItem().selectedMask ? st.masks.findIndex((m) => m.id === curItem().selectedMask) : -1;
        r.draw(st, { editChanged: true, overlay: oi });
        const px = new Uint8Array(4); r.gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, r.gl.RGBA, r.gl.UNSIGNED_BYTE, px);
        log.push(`canvas ${canvas.width}x${canvas.height} css ${canvas.clientWidth}x${canvas.clientHeight} center px ${[...px]} geo ${JSON.stringify(r.geo?.rect)} view ${JSON.stringify(r.view)} fit ${r.fit()} glerr ${r.gl.getError()}`); }
      // composite canvas + overlay
      const ov = document.getElementById('ov');
      const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
      const g = out.getContext('2d'); g.drawImage(canvas, 0, 0); g.drawImage(ov, 0, 0);
      const url = out.toDataURL('image/png');
      const im = document.createElement('img'); im.src = url;
      Object.assign(im.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: 5, pointerEvents: 'none' });
      document.getElementById('view').append(im);
      await post(url);
      log.push('items: ' + app.items.map((i) => `${i.name}${i.thumb ? '✓' : '✗'}`).join(' '));
      log.push('state: ' + JSON.stringify({ tool: app.tool, undo: curItem()?.hist?.idx, zoom: document.getElementById('zlabel').textContent }));
      const hc = document.querySelector('canvas.hist'); if (hc) await post(hc.toDataURL('image/png'), '-hist');
      if (q.get('shotpanel')) log.push('panel: ' + document.getElementById('panel').innerText.replace(/\n+/g, ' | ').slice(0, 400));
    } catch (e) { log.push('fatal: ' + (e.stack || e)); }
    await post(log.join('\n') || 'no errors', '-log');
  })();
}
