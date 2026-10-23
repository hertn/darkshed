// Last-writer-wins merge for the preset map: { name: { patch, updatedAt }, __deleted: { name: ts } }.
export function mergePresets(a = {}, b = {}) {
  const del = {};
  for (const src of [a.__deleted || {}, b.__deleted || {}]) for (const [n, t] of Object.entries(src)) del[n] = Math.max(del[n] || 0, t);
  const out = {};
  const names = new Set([...Object.keys(a), ...Object.keys(b)].filter((n) => n !== '__deleted'));
  for (const n of names) {
    const x = a[n], y = b[n];
    const pick = !x ? y : !y ? x : (x.updatedAt || 0) >= (y.updatedAt || 0) ? x : y;
    if ((del[n] || 0) > (pick.updatedAt || 0)) continue;     // deleted after it was last edited
    out[n] = pick;
  }
  const keep = Object.fromEntries(Object.entries(del).filter(([n]) => !out[n]));
  if (Object.keys(keep).length) out.__deleted = keep;
  return out;
}
