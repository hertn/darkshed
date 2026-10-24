// Grid / cull view: thumbnails of the whole library with filters. Clicking only selects (no decoding), so culling stays fast.
import { app, bus, curItem, setFilter, visibleItems } from '../app.js';
import * as lib from '../library.js';
import { icon } from './icons.js';
import { menu } from './overlays.js';
import { lsGet, lsSet } from '../store.js';

export function createGrid(host) {
  const root = document.createElement('div'); root.className = 'grid-view'; root.hidden = true;
  root.innerHTML = `
    <div class="grid-bar">
      <div class="seg" data-k="flag">
        <button data-v="all">All</button><button data-v="pick">Picks</button><button data-v="reject">Rejects</button><button data-v="none">Unflagged</button>
      </div>
      <label class="gl">Rating ≥ <select data-k="minRating"><option value="0">any</option><option value="1">★</option><option value="2">★★</option><option value="3">★★★</option><option value="4">★★★★</option><option value="5">★★★★★</option></select></label>
      <label class="gl">Sort <select data-k="sort"><option value="added">Added</option><option value="name">Name</option><option value="date">Date</option><option value="rating">Rating</option></select></label>
      <span class="grow"></span>
      <span class="gcount"></span>
      <input type="range" class="lr gsize" min="110" max="320" step="1" title="Thumbnail size">
    </div>
    <div class="grid-body"><div class="cells"></div></div>`;
  host.append(root);
  const cells = root.querySelector('.cells'), count = root.querySelector('.gcount'), size = root.querySelector('.gsize');
  let down = null, lastTap = { id: null, t: 0 };      // touch double-tap detection (the cells are rebuilt on every tap, so this lives here)
  let cursor = null;       // item id the keyboard cursor sits on
  let anchor = null;

  // phones start with two columns (about 150 px tiles) instead of one huge one; the size is remembered per kind of screen
  const phone = matchMedia('(max-width: 860px)').matches, SIZE_KEY = phone ? 'gridSizeM' : 'gridSize';
  size.value = lsGet(SIZE_KEY, phone ? '150' : '180');
  const applySize = () => { cells.style.setProperty('--cell', size.value + 'px'); lsSet(SIZE_KEY, size.value); };
  size.oninput = applySize; applySize();

  const seg = root.querySelector('.seg');
  seg.onclick = (e) => { const b = e.target.closest('button'); if (b) setFilter({ flag: b.dataset.v }); };
  for (const s of root.querySelectorAll('select')) s.onchange = () => setFilter({ [s.dataset.k]: s.dataset.k === 'minRating' ? +s.value : s.value });
  const paintBar = () => {
    for (const b of seg.children) b.classList.toggle('on', b.dataset.v === app.filter.flag);
    root.querySelector('[data-k=minRating]').value = app.filter.minRating;
    root.querySelector('[data-k=sort]').value = app.filter.sort;
  };

  function render() {
    paintBar();
    cells.textContent = '';
    const vis = visibleItems(true);
    count.textContent = vis.length === app.items.length ? `${vis.length} photos` : `${vis.length} of ${app.items.length}`;
    for (const it of vis) {
      const c = document.createElement('div'); c.className = 'cell'; c.dataset.id = it.id; c.title = it.name;
      const cv = document.createElement('canvas'); cv.width = 360; cv.height = 270;
      const meta = document.createElement('div'); meta.className = 'cmeta';
      meta.innerHTML = '<span class="nm"></span><span class="st"></span>'; meta.querySelector('.nm').textContent = it.name;
      meta.querySelector('.st').textContent = '★'.repeat(it.rating);
      c.append(cv, meta);
      if (it.flag) { const f = document.createElement('span'); f.className = 'flag ' + (it.flag > 0 ? 'pick' : 'reject'); f.innerHTML = icon(it.flag > 0 ? 'flag' : 'reject', 15); c.append(f); }
      if (lib.isEdited(it)) { const d = document.createElement('i'); d.className = 'edited'; c.append(d); }
      c.classList.toggle('sel', app.sel.has(it.id));
      c.classList.toggle('cur', it.id === cursor);
      c.classList.toggle('rejected', it.flag < 0);
      c.onpointerdown = (e) => onDown(e, it);
      c.ondblclick = () => open(it);
      c.oncontextmenu = (e) => { e.preventDefault(); tileMenu(it, { x: e.clientX, y: e.clientY }); };
      // phone: press and hold opens the same menu
      c.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        const sx = e.clientX, sy = e.clientY; clearTimeout(held); down = { x: sx, y: sy, t: performance.now() };
        held = setTimeout(() => { held = 0; tileMenu(it, { x: sx, y: sy }); }, 550);
      });
      c.addEventListener('pointermove', (e) => { if (held && Math.hypot(e.clientX - lastX(e), e.clientY - lastY(e)) > 8) { clearTimeout(held); held = 0; } });
      for (const t of ['pointerup', 'pointercancel']) c.addEventListener(t, () => { clearTimeout(held); held = 0; });
      // iOS sends no dblclick for touches: a quick second tap on the same photo opens it
      c.addEventListener('pointerup', (e) => {
        if (e.pointerType === 'mouse' || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10 || performance.now() - down.t > 350) { down = null; return; }
        const now = performance.now(); down = null;
        if (lastTap.id === it.id && now - lastTap.t < 450) { lastTap = { id: null, t: 0 }; open(it); } else lastTap = { id: it.id, t: now };
      });
      const more = document.createElement('button'); more.className = 'more'; more.textContent = '⋯'; more.title = 'More…';
      more.onpointerdown = (e) => e.stopPropagation();           // do not select / long-press through the button
      more.onclick = (e) => { e.stopPropagation(); const r = more.getBoundingClientRect(); tileMenu(it, { x: r.left, y: r.bottom }); };
      more.ondblclick = (e) => e.stopPropagation();
      c.append(more);
      cells.append(c);
      if (it.thumb) lib.drawThumb(cv, it, 'contain'); else { const sp = document.createElement('span'); sp.className = 'spin'; sp.textContent = '…'; c.append(sp); }
    }
    if (!vis.length) { const p = document.createElement('p'); p.className = 'gempty'; p.textContent = app.items.length ? 'No photos match this filter.' : 'No photos yet. Add some from the menu.'; cells.append(p); }
  }
  let held = 0, startX = 0, startY = 0;
  const lastX = () => startX, lastY = () => startY;
  function tileMenu(it, at) {
    if (!app.sel.has(it.id)) { app.sel = new Set([it.id]); render(); }
    const n = app.sel.size;
    menu([
      { label: 'Open', onClick: () => open(it) },
      'sep',
      { label: 'Pick', kb: 'P', onClick: () => lib.setFlag(1) }, { label: 'Reject', kb: 'X', onClick: () => lib.setFlag(-1) }, { label: 'Unflag', kb: 'U', onClick: () => lib.setFlag(0) },
      'sep',
      { label: 'Copy settings', onClick: () => bus.emit('cmd', 'copy') }, { label: 'Paste settings', onClick: () => bus.emit('cmd', 'paste'), disabled: !app.clip },
      { label: n > 1 ? `Export ${n} photos…` : 'Export…', onClick: () => bus.emit('cmd', 'export') },
      'sep',
      { label: n > 1 ? `Remove ${n} from library…` : 'Remove from library…', onClick: () => lib.confirmRemoveSelected() },
    ], at);
  }
  function onDown(e, it) {
    if (e.button === 2) return;
    startX = e.clientX; startY = e.clientY;
    const vis = visibleItems(true), i = vis.indexOf(it);
    if (e.metaKey || e.ctrlKey) { app.sel.has(it.id) ? app.sel.delete(it.id) : app.sel.add(it.id); anchor = it.id; }
    else if (e.shiftKey && anchor != null) {
      const a = vis.findIndex((x) => x.id === anchor); const [lo, hi] = [Math.min(a, i), Math.max(a, i)];
      app.sel = new Set(vis.slice(lo, hi + 1).map((x) => x.id));
    } else { app.sel = new Set([it.id]); anchor = it.id; }
    cursor = it.id;
    render();
  }
  function open(it) { hide(); lib.select(app.items.indexOf(it)); }

  function show() {
    root.hidden = false; host.classList.add('gridding');
    if (cursor == null || !app.items.some((x) => x.id === cursor)) cursor = curItem()?.id ?? app.items[0]?.id;
    if (!app.sel.size && cursor != null) app.sel = new Set([cursor]);
    render();
    cells.querySelector('.cell.cur')?.scrollIntoView({ block: 'nearest' });
    bus.emit('grid', true);
  }
  function hide() { root.hidden = true; host.classList.remove('gridding'); bus.emit('grid', false); }
  const visible = () => !root.hidden;

  /** Keyboard while the grid is open. Returns true if the key was used. */
  function key(e) {
    if (root.hidden) return false;
    const vis = visibleItems(true); if (!vis.length) return e.key === 'Escape' ? (hide(), true) : false;
    let i = Math.max(0, vis.findIndex((x) => x.id === cursor));
    const cols = Math.max(1, getComputedStyle(cells).gridTemplateColumns.split(' ').length);
    const mv = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    if (mv[e.key] !== undefined) {
      i = Math.min(vis.length - 1, Math.max(0, i + mv[e.key]));
      const it = vis[i];
      if (e.shiftKey && anchor != null) { const a = vis.findIndex((x) => x.id === anchor); app.sel = new Set(vis.slice(Math.min(a, i), Math.max(a, i) + 1).map((x) => x.id)); }
      else { app.sel = new Set([it.id]); anchor = it.id; }
      cursor = it.id; render();
      cells.querySelector('.cell.cur')?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (e.key === 'Enter' || e.key === 'e' || e.key === 'E') { open(vis[i]); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (!app.sel.size && vis[i]) app.sel = new Set([vis[i].id]); lib.confirmRemoveSelected(); return true; }
    if (e.key === 'Escape') { hide(); return true; }
    if (e.key === 'a' && (e.metaKey || e.ctrlKey)) { app.sel = new Set(vis.map((x) => x.id)); render(); return true; }
    return false;
  }

  bus.on('library', () => { if (!root.hidden) render(); });
  bus.on('meta', () => { if (!root.hidden) render(); });
  bus.on('history', () => { if (!root.hidden) render(); });
  return { show, hide, toggle: () => (visible() ? hide() : show()), visible, key, render };
}
