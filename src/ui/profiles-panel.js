// Profiles pane (RAW files): how the camera's raw data is rendered before your edits. One tile per profile, previewed on the current photo.
import { app, curItem, changed, commit, bus, renderState } from '../app.js';
import { clone } from '../params.js';
import { BASE_PROFILES } from '../tuning.js';
import { ensureCamFit } from '../camfit.js';
import { makeSmall, isRaw } from '../decode.js';
import { toast } from './overlays.js';

const NOTES = {
  '': 'The default look.',
  camera: 'Copies the look of the JPEG your camera stored inside the file.',
  neutral: 'Flatter, for more room to edit.',
  vivid: 'More contrast and colour.',
  landscape: 'Punchier, for scenery.',
  portrait: 'Softer, for skin.',
};

export function createProfilesPanel() {
  const el = document.createElement('div'); el.className = 'pane'; el.dataset.pane = 'profiles';
  el.innerHTML = '<div class="pane-title">Profiles</div>';
  const msg = document.createElement('p'); msg.className = 'hint'; msg.style.margin = '4px 16px 10px';
  const note = document.createElement('p'); note.className = 'hint pnote'; note.style.margin = '0 16px 10px';
  const wrap = document.createElement('div'); wrap.className = 'pgroup cur';
  const grid = document.createElement('div'); grid.className = 'preset-grid'; wrap.append(grid);
  el.append(msg, wrap, note);

  let tiles = [], thumbsFor = null, building = 0;

  function states(it) {
    const rs = renderState(it);
    return BASE_PROFILES.map(([, v]) => { const p = clone(it.params); p.baseProfile = v; return { p, raw: rs.raw, camera: rs.camera, wbGain: rs.wbGain, camFit: v === 'camera' ? it.camFit || null : null }; });
  }

  function rebuild() {
    const it = curItem();
    building++; grid.textContent = ''; tiles = [];
    const ok = it && isRaw(it.file);
    wrap.hidden = !ok; note.hidden = !ok;
    msg.hidden = ok;
    if (!ok) { msg.textContent = it ? 'Profiles are for RAW photos. A JPEG already has its look baked in.' : 'Open a RAW photo to choose its profile.'; return; }
    const cur = it.params.baseProfile || '';
    for (const [label, v] of BASE_PROFILES) {
      const d = document.createElement('div'); d.className = 'preset' + (v === cur ? ' on' : ''); d.title = NOTES[v];
      const c = document.createElement('canvas'); c.width = 96; c.height = 96;
      const s = document.createElement('span'); s.textContent = label;
      d.append(c, s);
      d.onclick = () => choose(v, label);
      grid.append(d); tiles.push({ canvas: c, el: d, value: v });
    }
    note.textContent = NOTES[cur];
    renderThumbs();
    if (!it.camFit && it.camFit !== null) ensureCamFit(it).then(() => { if (el.classList.contains('show') && curItem() === it) renderThumbs(); });
  }

  async function choose(v, label) {
    const it = curItem(); if (!it) return;
    it.params.baseProfile = v;
    for (const t of tiles) t.el.classList.toggle('on', t.value === v);
    note.textContent = NOTES[v];
    if (v === 'camera' && it.camFit === undefined) toast("Matching the camera's own look…");
    if (v === 'camera' && !(await ensureCamFit(it))) toast('This file has no usable camera preview, so Camera Matching has no effect.', 4000);
    changed({ edit: true }); commit(`Profile: ${label}`);
    renderThumbs();
  }

  function renderThumbs() {
    const r = app.renderer, L = app.loaded, it = curItem();
    if (!r || !L || !it || !tiles.length) return;
    const token = ++building;
    if (thumbsFor !== L.img) { const sm = makeSmall(L.img, 192); r.setSmall(sm.w, sm.h, sm.half); thumbsFor = L.img; }
    const out = r.renderThumbs(states(it));
    if (token !== building) return;
    tiles.forEach((t, k) => {
      const px = out[k]; if (!px) return;
      const c = t.canvas, g = c.getContext('2d');
      const tmp = document.createElement('canvas'); tmp.width = px.w; tmp.height = px.h;
      tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.data), px.w, px.h), 0, 0);
      const s = Math.max(c.width / px.w, c.height / px.h);
      g.drawImage(tmp, (c.width - px.w * s) / 2, (c.height - px.h * s) / 2, px.w * s, px.h * s);
    });
  }

  // the other panels share the small preview texture, so it is reset whenever another photo is shown
  bus.on('select', () => { thumbsFor = null; if (el.classList.contains('show')) rebuild(); });
  bus.on('history', () => { if (el.classList.contains('show')) rebuild(); });

  return { el, impl: null, onEnter() { thumbsFor = null; rebuild(); }, onLeave() { building++; } };
}
