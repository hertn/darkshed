// Context menus, modals, toasts.
import { icon } from './icons.js';

export function toast(msg, ms = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

let closeMenu = null;
let openAnchor = null;                          // the button the open menu belongs to: pressing it again closes the menu
/** items: [{label, kb, onClick, check, disabled}] or 'sep'. Anchored at (x, y) or to an element. */
export function menu(items, at) {
  if (at instanceof Element && closeMenu && openAnchor === at) { closeMenu(); return null; }
  closeMenu?.();
  const root = document.getElementById('menuRoot');
  const m = document.createElement('div'); m.className = 'menu';
  for (const it of items) {
    if (it === 'sep') { m.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    const lab = document.createElement('span'); lab.className = 'lab' + (it.check === true ? ' chk' : it.check === false ? ' nochk' : ''); lab.textContent = it.label;
    b.append(lab);
    if (it.kb) { const k = document.createElement('span'); k.className = 'kb'; k.textContent = it.kb; b.append(k); }
    if (it.disabled) { b.disabled = true; b.style.opacity = '.4'; }
    b.onclick = () => { closeMenu?.(); it.onClick?.(); };
    m.append(b);
  }
  root.append(m);
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, bottom: at.y, top: at.y, right: at.x };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = r.left, y = r.bottom + 4;
  if (x + mw > innerWidth - 8) x = Math.max(8, (at instanceof Element ? r.right : x) - mw);
  if (y + mh > innerHeight - 8) y = Math.max(8, (at instanceof Element ? r.top - mh - 4 : innerHeight - mh - 8));
  m.style.left = x + 'px'; m.style.top = y + 'px';
  const ax = at instanceof Element ? (r.left + r.right) / 2 : r.left;
  m.style.transformOrigin = Math.max(0, Math.min(mw, ax - x)) + 'px ' + (y < r.top ? mh : 0) + 'px';      // grows out of the button it belongs to
  openAnchor = at instanceof Element ? at : null;
  const off = (e) => { if (!m.contains(e.target)) { if (at instanceof Element && at.contains(e.target)) return; closeMenu?.(); } };   // the button itself toggles on click
  const key = (e) => { if (e.key === 'Escape') closeMenu?.(); };
  setTimeout(() => { addEventListener('pointerdown', off, true); addEventListener('keydown', key, true); }, 0);
  closeMenu = () => { m.remove(); removeEventListener('pointerdown', off, true); removeEventListener('keydown', key, true); closeMenu = null; openAnchor = null; };
  return closeMenu;
}

/** Simple modal. build(body) fills the content; returns { close, body, foot }. */
export function modal(title, build, { buttons = [], closeX = true } = {}) {
  const root = document.getElementById('modalRoot');
  const back = document.createElement('div'); back.className = 'modal-back';
  const m = document.createElement('div'); m.className = 'modal';
  const h = document.createElement('h3'); h.textContent = title;
  const body = document.createElement('div'); body.className = 'm-body';
  const foot = document.createElement('div'); foot.className = 'm-foot';
  m.append(h, body, foot); back.append(m); root.append(back);
  if (!buttons.length) foot.remove();
  const close = () => { back.remove(); removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (root.lastElementChild !== back) return;          // only the window on top answers
    if (e.key === 'Escape') close();
    // Enter confirms (the primary button); text fields, lists and focused buttons keep their own Enter
    else if (e.key === 'Enter' && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) {
      const b = foot.querySelector('.btn.primary'); if (!b) return;
      e.preventDefault(); e.stopPropagation(); b.click();
    }
  };
  addEventListener('keydown', onKey, true);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  if (closeX) {          // close button in the top-right corner
    h.classList.add('with-x');
    const x = document.createElement('button'); x.className = 'm-x'; x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.innerHTML = '&times;'; x.onclick = close;
    h.append(x);
  }
  const api = { close, body, foot, title: h };
  build(body, api);
  for (const b of buttons) {
    const el = document.createElement('button'); el.className = 'btn' + (b.primary ? ' primary' : ''); el.textContent = b.label;
    el.onclick = () => b.onClick?.(api, el);
    foot.append(el);
  }
  return api;
}
export { icon };
