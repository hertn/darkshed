// Lightroom-style slider: label + editable value on top, thin track underneath.
const TRACKS = {
  temp: 'linear-gradient(to right, #3d7fe6, #8fb4ee 45%, #f5f0d8 50%, #f2c35a 75%, #f09a1a)',
  tint: 'linear-gradient(to right, #3fbf6a, #8fd9a8 45%, #ececec 50%, #e9a0d2 75%, #e03fae)',
  vibrance: 'linear-gradient(to right, #6b6b6b, #c9444d 60%, #f0a030 80%, #5ec36b)',
  saturation: 'linear-gradient(to right, #777, #c9444d 60%, #f0a030 80%, #5ec36b)',
};

/**
 * opts: { label, min, max, step, def, value, track, color, onInput(v), onChange(v), format(v) }
 * returns { el, set(v), get(), def }
 */
export function slider(o) {
  const { min, max, step, def } = o;
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const plain = (v) => (v > 0 && min < 0 ? '+' : '') + v.toFixed(dec);
  let fmt = o.format || plain, parse = o.parse || ((t) => parseFloat(t.replace('+', '')));
  const el = document.createElement('div'); el.className = 'sl';
  const top = document.createElement('div'); top.className = 'sl-top';
  const lab = document.createElement('label');
  if (o.color) { const d = document.createElement('i'); d.className = 'dot'; d.style.background = o.color; lab.append(d); }
  lab.append(o.label);
  const val = document.createElement('input'); val.type = 'text'; val.className = 'sl-val'; val.inputMode = 'decimal'; val.spellcheck = false;
  top.append(lab, val);
  const rng = document.createElement('input'); rng.type = 'range'; rng.className = 'lr';
  rng.min = min; rng.max = max; rng.step = step;
  el.append(top, rng);

  let value = o.value ?? def;
  let custom = null;
  const pct = (v) => ((v - min) / (max - min)) * 100;
  function paint() {
    rng.value = value; val.value = fmt(value);
    el.classList.toggle('mod', value !== def);
    const css = custom || TRACKS[o.track];
    if (css) { rng.style.setProperty('--tr', css); return; }
    const a = pct(Math.min(value, min < 0 ? 0 : min)), b = pct(Math.max(value, min < 0 ? 0 : min));
    const on = value !== def ? 'var(--acc)' : '#8a8a8a';
    rng.style.setProperty('--tr', `linear-gradient(to right, var(--track) 0 ${a}%, ${on} ${a}% ${b}%, var(--track) ${b}% 100%)`);
  }
  let snap = null;                                  // optional: snaps a value to what the display units allow (Kelvin in 50s)
  const clamp = (v) => (snap ? snap(Math.min(max, Math.max(min, v))) : Math.min(max, Math.max(min, Math.round(v / step) * step)));
  rng.addEventListener('input', () => { value = clamp(+rng.value); paint(); o.onInput?.(value); });
  rng.addEventListener('change', () => o.onChange?.(value));
  const reset = () => { value = def; paint(); o.onInput?.(value); o.onChange?.(value); };
  rng.addEventListener('dblclick', reset);
  lab.addEventListener('dblclick', reset);
  // touch screens do not reliably send dblclick: detect a quick second tap ourselves (on the track or the label)
  for (const target of [rng, lab]) {
    let downX = 0, downY = 0, last = 0;
    target.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
    target.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 8) { last = 0; return; }
      const now = performance.now();
      if (now - last < 400) { last = 0; reset(); } else last = now;
    });
  }
  val.addEventListener('focus', () => val.select());
  val.addEventListener('keydown', (e) => { if (e.key === 'Enter') val.blur(); else if (e.key === 'Escape') { paint(); val.blur(); } e.stopPropagation(); });
  val.addEventListener('blur', () => {
    const n = parse(val.value);
    if (Number.isFinite(n) && clamp(n) !== value) { value = clamp(n); paint(); o.onInput?.(value); o.onChange?.(value); } else paint();
  });
  paint();
  return { el, def, set(v) { value = v; paint(); }, get: () => value, setTrack(css) { custom = css; paint(); },
    /** Show the value in other units (e.g. Kelvin): format(v) -> text, parse(text) -> v. Call with no arguments to go back to plain numbers. */
    setUnits(format, parser, snapper) { fmt = format || plain; parse = parser || ((t) => parseFloat(t.replace('+', ''))); snap = snapper || null; rng.step = snap ? 0.1 : step; paint(); } };
}
