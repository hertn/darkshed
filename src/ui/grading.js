// Colour grading, modelled on Lightroom: a wheel each for shadows, midtones and highlights (all three visible together on a
// desktop panel), a Global wheel, a luminance slider under every wheel, and Blending / Balance.
// On a phone the same pages sit side by side in a strip you swipe through, with tabs on top.
import { createWheel } from './wheel.js';
import { slider } from './slider.js';
import { GRADE_ZONES } from '../params.js';
import { lsGet, lsSet } from '../store.js';

const PAGES = [...GRADE_ZONES.map(([z, label]) => [z, label]), ['blend', 'Blend']];

// set by createGrading; lets the phone layout tell the strip it just became visible
let shown = () => {};
export const gradingShown = () => shown();

/** api: { params(), live(), commit(label), setLum(zone, v) } */
export function createGrading(api) {
  const el = document.createElement('div'); el.className = 'grade';
  const tabs = document.createElement('div'); tabs.className = 'grade-tabs';
  const track = document.createElement('div'); track.className = 'grade-track';
  el.append(tabs, track);

  const wheels = {}, lums = {}, reads = {}, tabEls = {}, pages = {};
  let cur = Math.max(0, PAGES.findIndex(([z]) => z === lsGet('gradeZone', 'shadow')));

  for (const [z, label] of PAGES) {
    const t = document.createElement('button'); t.className = 'tab'; t.textContent = label;
    t.onclick = () => go(PAGES.findIndex(([id]) => id === z), true);
    tabEls[z] = t; tabs.append(t);

    const pg = document.createElement('div'); pg.className = 'gpage'; pg.dataset.z = z;
    pages[z] = pg; track.append(pg);
    if (z === 'blend') continue;

    const name = document.createElement('div'); name.className = 'gname'; name.textContent = label;
    const wrap = document.createElement('div'); wrap.className = 'wheel-wrap';
    const w = createWheel({
      onInput: (h, s) => {
        const p = api.params(); if (!p) return;
        p[`grade_${z}_hue`] = h; p[`grade_${z}_sat`] = s;
        readout(z); api.live();
      },
      onCommit: () => api.commit('Color grading'),
    });
    wrap.append(w.el);
    const side = document.createElement('div'); side.className = 'gside';
    const read = document.createElement('div'); read.className = 'gread';
    const lum = slider({
      label: 'Lum', min: -100, max: 100, step: 1, def: 0, value: 0,
      onInput: (v) => api.setLum(z, v), onChange: () => api.commit('Color grading'),
    });
    side.append(read, lum.el);
    pg.append(name, wrap, side);
    wheels[z] = w; lums[z] = lum; reads[z] = read;
  }

  function readout(z) {
    const p = api.params(); if (!p) return;
    const s = p[`grade_${z}_sat`] ?? 0;
    reads[z].textContent = s ? `H ${Math.round(p[`grade_${z}_hue`] ?? 0)}°  S ${Math.round(s)}` : 'H –  S 0';
  }

  // ----- phone: swipe strip + tabs -----
  const width = () => track.clientWidth;
  function paintTabs() { PAGES.forEach(([z], i) => tabEls[z].classList.toggle('on', i === cur)); }
  function go(i, smooth) {
    cur = i; lsSet('gradeZone', PAGES[i][0]); paintTabs();
    if (width() && track.scrollWidth > track.clientWidth + 2) track.scrollTo({ left: i * width(), behavior: smooth ? 'smooth' : 'instant' });
  }
  let raf = 0;
  track.addEventListener('scroll', () => {
    if (raf || track.scrollWidth <= track.clientWidth + 2) return;     // on desktop the strip does not scroll
    raf = requestAnimationFrame(() => {
      raf = 0;
      const i = Math.max(0, Math.min(PAGES.length - 1, Math.round(track.scrollLeft / (width() || 1))));
      if (i !== cur) { cur = i; lsSet('gradeZone', PAGES[i][0]); paintTabs(); }
    });
  });
  paintTabs();

  const self = {
    el,
    blendHost: pages.blend,
    /** pull values from the current photo */
    sync() {
      const p = api.params(); if (!p) return;
      for (const [z] of GRADE_ZONES) {
        wheels[z].set(p[`grade_${z}_hue`] ?? 0, (p[`grade_${z}_sat`] ?? 0) / 100);
        lums[z].set(p[`grade_${z}_lum`] ?? 0);
        readout(z);
      }
    },
    /** dots on the tabs for zones that have a grade */
    mark(isDef) {
      for (const [z] of GRADE_ZONES) tabEls[z].classList.toggle('mod', ['hue', 'sat', 'lum'].some((k) => !isDef(`grade_${z}_${k}`)) && (!isDef(`grade_${z}_sat`) || !isDef(`grade_${z}_lum`)));
      tabEls.blend.classList.toggle('mod', !isDef('grade_blend') || !isDef('grade_balance'));
    },
    /** call when the view becomes visible (the strip cannot scroll while hidden) */
    show() { requestAnimationFrame(() => { go(cur, false); for (const w of Object.values(wheels)) w.redraw(); }); },
  };
  shown = () => self.show();
  return self;
}
