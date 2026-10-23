// .cube LUT import (3D only) -> RGBA8 3D texture data.
export function parseCube(text) {
  let size = 0, title = '', min = [0, 0, 0], max = [1, 1, 1], is1d = false;
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    if (line.startsWith('TITLE')) { title = line.replace(/^TITLE\s*/, '').replace(/^"|"$/g, ''); continue; }
    if (line.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (line.startsWith('LUT_1D_SIZE')) { is1d = true; continue; }
    if (line.startsWith('DOMAIN_MIN')) { min = line.split(/\s+/).slice(1).map(Number); continue; }
    if (line.startsWith('DOMAIN_MAX')) { max = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]+/.test(line)) continue;
    const p = line.split(/\s+/).map(Number);
    if (p.length >= 3 && p.every(Number.isFinite)) vals.push(p[0], p[1], p[2]);
  }
  if (is1d && !size) throw new Error('1D LUTs are not supported, use a 3D .cube');
  if (!size || vals.length < size ** 3 * 3) throw new Error('Not a valid 3D .cube file');
  const n = size ** 3, data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = (vals[i * 3 + c] - min[c]) / (max[c] - min[c] || 1);
      data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    data[i * 4 + 3] = 255;
  }
  return { size, data, title };
}
