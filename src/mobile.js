// Phone / small-tablet layout, modelled on Lightroom mobile:
//   photo fills the middle and never scrolls, a tool dock sits along the bottom, and tapping a tool opens a resizable
//   bottom sheet that shows just that tool (or just that Edit section). Only the sheet scrolls.
import { app, bus } from './app.js';
import { icon } from './ui/icons.js';
import { lsGet, lsSet } from './store.js';

const MQ = window.matchMedia('(max-width: 860px)');
const SECTIONS = [['light', 'Light', 'sun'], ['color', 'Color', 'palette'], ['effects', 'Effects', 'fx'], ['detail', 'Detail', 'detail'], ['optics', 'Optics', 'lens'], ['calibration', 'Calibrate', 'calib']];
const TITLES = { curves: 'Curves' };      // reached from the Light section, not from the dock
const TOOLS = [['crop', 'Crop', 'crop'], ['spots', 'Heal', 'heal'], ['mask', 'Masks', 'mask'], ['presets', 'Presets', 'presets'], ['info', 'Info', 'info']];

export function initMobile({ setToolId }) {
  const dock = document.getElementById('dock');
  const panel = document.getElementById('panel');
  const view = document.getElementById('view');
  const state = { section: lsGet('mSection', 'light'), open: lsGet('mSheetOpen', '1') === '1' };
  const items = new Map();                                   // key -> button

  // ----- dock -----
  const mk = (key, label, ic) => {
    const b = document.createElement('button'); b.className = 'dk'; b.dataset.key = key;
    b.innerHTML = `${icon(ic, 22)}<span>${label}</span>`;
    b.onclick = () => choose(key);
    items.set(key, b); dock.append(b);
  };
  // Auto is an action, not a tool: tap to apply an automatic tone
  { const b = document.createElement('button'); b.className = 'dk dk-auto'; b.dataset.key = 'auto'; b.innerHTML = `${icon('autoedit', 22)}<span>Auto</span>`;
    b.onclick = () => { bus.emit('cmd', 'auto'); b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 400); }; dock.append(b); }
  { const s0 = document.createElement('i'); s0.className = 'dk-sep'; dock.append(s0); }
  for (const [id, l, ic] of SECTIONS) mk('sec:' + id, l, ic);
  const sep = document.createElement('i'); sep.className = 'dk-sep'; dock.append(sep);
  for (const [id, l, ic] of TOOLS) mk(id, l, ic);

  // ----- sheet header: just the tool's name (the height is fixed, like Lightroom mobile) -----
  const handle = document.createElement('div'); handle.className = 'sheet-handle';
  handle.innerHTML = '<span class="sh-title"></span>';
  panel.prepend(handle);

  // ----- behaviour -----
  function showSection(id) {
    state.section = id; lsSet('mSection', id);
    for (const d of panel.querySelectorAll('details.sec')) {
      const on = d.dataset.sec === id;
      d.classList.toggle('mshow', on);
      if (on) d.open = true;
    }
    handle.querySelector('.sh-title').textContent = TITLES[id] || SECTIONS.find((s) => s[0] === id)?.[1] || '';
    floatCurve(id === 'curves' && state.open);
  }
  function setOpen(v) { state.open = v; lsSet('mSheetOpen', v ? '1' : '0'); document.body.classList.toggle('sheet-closed', !v); floatCurve(state.section === 'curves' && v && app.tool === 'edit'); setTimeout(() => window.dispatchEvent(new Event('resize')), 50); }
  function paintDock() {
    let key = app.tool === 'edit' ? 'sec:' + state.section : app.tool;
    if (key === 'sec:curves') key = 'sec:light';                  // Curves is part of Light
    for (const [k, b] of items) b.classList.toggle('on', k === key && state.open);
    items.get(key)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  function choose(key, fromDock = true) {
    const cur = app.tool === 'edit' ? 'sec:' + state.section : app.tool;
    const active = cur === key || (cur === 'sec:curves' && key === 'sec:light');
    if (fromDock && active && state.open) { setOpen(false); paintDock(); return; }   // tap the open tool again: collapse the sheet
    if (key.startsWith('sec:')) { showSection(key.slice(4)); setToolId('edit'); }
    else { floatCurve(false); setToolId(key); handle.querySelector('.sh-title').textContent = TOOLS.find((t) => t[0] === key)?.[1] || ''; }
    setOpen(true); paintDock();
  }
  bus.on('tool', () => {
    if (app.tool !== 'edit') { floatCurve(false); handle.querySelector('.sh-title').textContent = TOOLS.find((t) => t[0] === app.tool)?.[1] || ''; }
    else showSection(state.section);
    paintDock();
  });

  // ----- curves: a "Curves" button in the Light section, and the curve drawn see-through over the photo -----
  const mkSmall = (cls, ic, text, fn) => { const b = document.createElement('button'); b.className = 'mini m-only ' + cls; b.innerHTML = `${icon(ic, 16)}<span>${text}</span>`; b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); }; return b; };
  const lightTail = panel.querySelector('details.sec[data-sec=light] > summary .tail');
  const curvesTail = panel.querySelector('details.sec[data-sec=curves] > summary .tail');
  lightTail?.prepend(mkSmall('curves-btn', 'curve', 'Curves', () => choose('sec:curves', false)));
  curvesTail?.prepend(mkSmall('back-btn', 'sun', 'Light', () => choose('sec:light', false)));
  const curveCv = panel.querySelector('canvas.curve');
  const curveHome = curveCv ? { parent: curveCv.parentNode, next: curveCv.nextSibling } : null;
  function sizeCurve() {
    if (!curveCv || !curveCv.classList.contains('float')) return;
    const r = view.getBoundingClientRect(), side = Math.max(120, Math.min(r.width, r.height) - 28);
    curveCv.style.width = side + 'px'; curveCv.style.height = side + 'px';
  }
  function floatCurve(on) {
    if (!curveCv) return;
    document.body.classList.toggle('curves-open', !!on);
    if (on) { curveCv.classList.add('float'); view.append(curveCv); sizeCurve(); }
    else if (curveCv.classList.contains('float')) {
      curveCv.classList.remove('float'); curveCv.style.width = ''; curveCv.style.height = '';
      curveHome.parent.insertBefore(curveCv, curveHome.next);
    }
  }
  new ResizeObserver(sizeCurve).observe(view);

  // ----- histogram becomes a small overlay on the photo -----
  const histWrap = () => panel.querySelector('.hist-wrap');
  const head = () => panel.querySelector('.edit-head');
  const hide = lsGet('mHist', '1') === '0';
  function floatHist(on) {
    const hw = histWrap(); if (!hw) return;
    if (on) { hw.classList.add('hist-float'); hw.classList.toggle('off', lsGet('mHist', '1') === '0'); view.append(hw); hw.onclick = () => { const off = hw.classList.toggle('off'); lsSet('mHist', off ? '0' : '1'); }; }
    else { hw.classList.remove('hist-float', 'off'); hw.onclick = null; head()?.prepend(hw); }
  }
  void hide;

  // ----- enable / disable with the viewport -----
  function apply() {
    const on = MQ.matches;
    document.body.classList.toggle('m', on);
    floatHist(on);
    if (on) { setOpen(state.open); showSection(state.section); paintDock(); } else floatCurve(false);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  }
  MQ.addEventListener('change', apply);
  addEventListener('orientationchange', () => setTimeout(() => window.dispatchEvent(new Event('resize')), 250));
  apply();
}
