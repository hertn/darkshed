// About dialog. The wording lives here, edit freely.
import { bus } from '../app.js';
import { modal } from './overlays.js';
import { logoSvg } from './logo.js';

export const ABOUT = {
  tagline: 'A darkroom, but in a shed.',
  intro: 'A free, Lightroom-style RAW and JPEG editor that runs in your browser on Mac, iPad and iPhone. Built because Lightroom costs money and the other "Lightroom killers" were desktop-only.',
  points: [
    ['Private', 'Edits run on your device. Photos are never uploaded.'],
    ['Synced presets', 'Presets and LUTs can sync through your own DarkShed server.'],
    ['RAW ready', 'Opens Fujifilm RAF and more, and imports Lightroom presets.'],
  ],
  credits: 'Open source (MIT). RAW decoding by LibRaw (LGPL 2.1 / CDDL 1.0) via libraw-wasm.',
  disclaimer: 'Not affiliated with Adobe or Fujifilm. The Fujifilm-style looks are approximations, not real film simulations.',
  byline: 'Directed by <b style="color:var(--fg)">Hert Niks</b>. Built by <b style="color:var(--fg)">Claude</b>, an AI made by Anthropic.',
  links: [['GitHub', 'https://github.com/hertn']],
};

bus.on('open-about', () => {
  modal('About DarkShed', (body) => {
    const head = document.createElement('div'); head.style.cssText = 'display:flex;align-items:center;gap:14px;padding:6px 20px 10px';
    head.innerHTML = `${logoSvg(56)}<div><div style="font-size:20px;font-weight:600">Dark<span style="color:var(--acc)">Shed</span></div><div style="color:var(--mut);font-size:12px">Version ${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''}</div></div>`;
    body.append(head);
    const para = (html, css = '') => { const p = document.createElement('p'); p.style.cssText = 'margin:6px 20px;font-size:13px;line-height:1.55;color:var(--fg2);' + css; p.innerHTML = html; body.append(p); };
    para(`<b style="color:var(--fg)">${ABOUT.tagline}</b>`);
    para(ABOUT.intro);
    for (const [t, d] of ABOUT.points) para(`<b style="color:var(--fg)">${t}.</b> ${d}`, 'margin-top:10px');
    if (ABOUT.links.length) para(ABOUT.links.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener" style="color:var(--acc)">${t}</a>`).join(' &nbsp;·&nbsp; '), 'margin-top:12px');
    const rule = document.createElement('div'); rule.style.cssText = 'height:1px;background:var(--line);margin:14px 20px 4px'; body.append(rule);
    para(ABOUT.byline, 'font-size:12px;color:var(--mut);margin-top:10px');
    para(ABOUT.credits, 'font-size:12px;color:var(--mut)');
    para(ABOUT.disclaimer, 'font-size:12px;color:var(--mut)');
    // screen diagnostics: handy when the layout looks wrong on a phone
    const probe = document.createElement('div'); probe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;padding-bottom:env(safe-area-inset-bottom);visibility:hidden'; document.body.append(probe);
    const inset = probe.offsetHeight; probe.remove();
    const r = (id) => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().bottom) : '-'; };
    const unit = (h) => { const e = document.createElement('div'); e.style.cssText = `position:fixed;left:0;top:0;width:1px;height:${h};visibility:hidden`; document.body.append(e); const v = Math.round(e.getBoundingClientRect().height); e.remove(); return v; };
    const topIn = (() => { const e = document.createElement('div'); e.style.cssText = 'position:fixed;left:0;top:0;width:1px;padding-top:env(safe-area-inset-top);visibility:hidden'; document.body.append(e); const v = e.offsetHeight; e.remove(); return v; })();
    const units = `vh ${unit('100vh')} dvh ${unit('100dvh')} svh ${unit('100svh')} lvh ${unit('100lvh')} fill ${unit('-webkit-fill-available')} top inset ${topIn} appTop ${Math.round(document.getElementById('app').getBoundingClientRect().top)} availH ${screen.availHeight} clientH ${document.documentElement.clientHeight} vvTop ${window.visualViewport ? Math.round(window.visualViewport.offsetTop) : '-'}`;
    const vv = window.visualViewport;
    const diag = `Display: ${navigator.standalone || matchMedia('(display-mode: standalone)').matches ? 'home-screen app' : 'browser'} · window ${innerWidth}×${innerHeight} · screen ${screen.width}×${screen.height} · visual ${vv ? Math.round(vv.width) + '×' + Math.round(vv.height) : '-'} · bottom inset ${inset} · app bottom ${r('app')} · dock bottom ${r('dock')}\n${units}`;
    para(diag, 'font-size:11px;color:var(--dim);font-family:ui-monospace,monospace');
    if (import.meta.env.DEV) fetch('/__shot?name=phone-diag', { method: 'POST', body: diag + '\n' + navigator.userAgent + '\nvh probe: ' + Math.round(document.documentElement.getBoundingClientRect().height) }).catch(() => {});
  }, { buttons: [{ label: 'Close', primary: true, onClick: (m) => m.close() }] });
});
