// Sync & settings dialog.
import { bus } from '../app.js';
import { modal, toast } from './overlays.js';
import { sync, syncNow, ping } from '../sync.js';
import { lsGet, lsSet } from '../store.js';
import { storageInfo, clearStored, keepPrefs, applyLimitsNow } from '../persist.js';

bus.on('open-settings', () => {
  let statusEl;
  const paint = () => { if (statusEl) statusEl.textContent = sync.enabled ? `Connected${sync.last ? ' · last sync ' + new Date(sync.last).toLocaleTimeString() : ''}` : `Not connected (${sync.status})`; };
  modal('Sync & settings', (body) => {
    const intro = document.createElement('p'); intro.className = 'hint'; intro.style.margin = '4px 20px 10px';
    intro.textContent = 'Presets and imported LUTs sync through your DarkShed server. Photos never leave your device. When the app is served by the DarkShed server it connects automatically.';
    body.append(intro);
    const row = (label, el) => { const r = document.createElement('div'); r.className = 'field-row'; const l = document.createElement('label'); l.textContent = label; r.append(l, el); body.append(r); };
    const url = document.createElement('input'); url.type = 'text'; url.placeholder = 'Same site (leave empty)'; url.value = lsGet('syncUrl', ''); url.autocapitalize = 'off'; url.spellcheck = false;
    const tok = document.createElement('input'); tok.type = 'password'; tok.placeholder = 'Only if the server needs one'; tok.value = lsGet('syncToken', '');
    row('Server URL', url); row('Token', tok);
    statusEl = document.createElement('div'); statusEl.className = 'm-msg'; body.append(statusEl); paint();
    const btns = document.createElement('div'); btns.className = 'btn-row';
    const save = () => { lsSet('syncUrl', url.value.trim()); lsSet('syncToken', tok.value.trim()); };
    const test = document.createElement('button'); test.className = 'btn small'; test.textContent = 'Test connection';
    test.onclick = async () => { save(); const r = await ping(); toast(r.ok ? 'Connected' : r.msg); };
    const go = document.createElement('button'); go.className = 'btn small primary'; go.textContent = 'Sync now';
    go.onclick = async () => { save(); await syncNow(false); paint(); };
    btns.append(test, go); body.append(btns);
    // photos kept on this device so the library survives the app being reloaded
    const stTitle = document.createElement('div'); stTitle.className = 'group-title'; stTitle.textContent = 'Photos kept on this device'; stTitle.style.paddingTop = '14px';
    const stExplain = document.createElement('p'); stExplain.className = 'hint'; stExplain.style.cssText = 'margin:2px 20px 8px;font-size:12.5px;line-height:1.5';
    stExplain.innerHTML = 'When you open a photo, DarkShed keeps a <b>copy</b> in this browser, on this device only, so your work is still here after the app reloads. Nothing is uploaded and your originals are never touched. A copy is deleted when you remove the photo, when it has gone unused for the time below, or (oldest first) when the stored photos pass the size limit.';
    body.append(stTitle, stExplain);
    const sel = (opts, val) => { const x = document.createElement('select'); for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; x.append(o); } x.value = String(val); return x; };
    const keepSel = sel([['1', 'Yes, keep copies'], ['0', 'No, do not keep copies']], keepPrefs.keep ? 1 : 0);
    const daysSel = sel([['1', 'After 1 day unused'], ['7', 'After 7 days unused'], ['30', 'After 30 days unused'], ['0', 'Never (only when I remove them)']], keepPrefs.days);
    const capSel = sel([['500', '500 MB'], ['1024', '1 GB'], ['2048', '2 GB'], ['0', 'No limit']], keepPrefs.capMB);
    row('Keep copies', keepSel); row('Delete', daysSel); row('Size limit', capSel);
    const stMsg = document.createElement('div'); stMsg.className = 'm-msg'; stMsg.textContent = 'Checking…'; stMsg.style.lineHeight = '1.5';
    const stRow = document.createElement('div'); stRow.className = 'btn-row';
    const clean = document.createElement('button'); clean.className = 'btn small'; clean.textContent = 'Clean up now';
    const clr = document.createElement('button'); clr.className = 'btn small danger ghost'; clr.textContent = 'Delete all stored copies';
    stRow.append(clean, clr); body.append(stMsg, stRow);
    const mb = (n) => (n > 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n < 1048576 ? Math.round(n / 1024) + ' KB' : Math.round(n / 1048576) + ' MB');
    async function refreshStorage() {
      const i = await storageInfo();
      const when = i.nextExpiry ? ` The one unused longest is removed on ${new Date(i.nextExpiry).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} unless you open it again.` : '';
      const free = i.quota ? i.quota - i.usage : 0, low = i.quota && (free < 300 * 1048576 || i.usage / i.quota > 0.9);
      stMsg.innerHTML = `${i.count} photo${i.count === 1 ? '' : 's'} stored using <b>${mb(i.bytes)}</b>.${keepPrefs.keep ? when : ' Copies are not being kept, so photos are lost if the app reloads.'}`
        + (i.quota ? `<br><span style="color:${low ? 'var(--warn)' : 'var(--mut)'}">${low ? 'Low space: ' : ''}This device allows the app about ${mb(i.quota)} and ${mb(free)} of that is free.</span>` : '');
    }
    const changed = async () => { keepPrefs.days = +daysSel.value; keepPrefs.capMB = +capSel.value; const n = await applyLimitsNow(); if (n) toast(`${n} stored photo${n === 1 ? '' : 's'} removed to match your settings`); refreshStorage(); };
    daysSel.onchange = changed; capSel.onchange = changed;
    keepSel.onchange = async () => {
      keepPrefs.keep = keepSel.value === '1';
      if (!keepPrefs.keep && confirm('Also delete the copies that are already stored? (Photos you have open stay open until the app reloads.)')) { await clearStored(); toast('Stored copies deleted'); }
      refreshStorage();
    };
    clean.onclick = changed;
    clr.onclick = async () => { if (!confirm('Delete every stored copy from this device? Your original files are not touched, but the library will be empty after a reload.')) return; await clearStored(); toast('Stored copies deleted'); refreshStorage(); };
    refreshStorage();
    const tips = document.createElement('p'); tips.className = 'hint'; tips.style.margin = '10px 20px 6px';
    tips.textContent = 'Install: on iPhone / iPad use Share → Add to Home Screen; on desktop Chrome use the install icon in the address bar.';
    body.append(tips);
  }, { buttons: [{ label: 'Close', primary: true, onClick: (m) => m.close() }] });
});
bus.on('sync-status', () => {});
