// Image helpers: fetch from URL, load local file, make data URIs for the API,
// and build a labeled side-by-side comparison sheet for the critic.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export async function fetchImage(url, dest) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'img2env/0.1 (local reconstruction tool)' } });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  // normalize to PNG so downstream is predictable
  const png = await sharp(buf).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  if (dest) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, png); }
  return png;
}

export function fileToDataUri(p) {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export function bufToDataUri(buf, mime = 'image/png') {
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

// Downscale a file's data URI for cheaper vision calls.
export async function fileToScaledDataUri(p, max = 768) {
  const buf = await sharp(p).rotate().resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return bufToDataUri(buf);
}

// Generic labeled montage of N images in a row. panels = [{path, label}].
export async function montage(panels, outPath, H = 460) {
  const pad = 10, labelH = 26;
  const imgs = [];
  for (const p of panels) {
    try { imgs.push({ buf: await sharp(p.path).resize({ height: H, fit: 'inside' }).toBuffer(), label: p.label }); }
    catch { imgs.push({ buf: await sharp({ create: { width: H, height: H, channels: 3, background: '#222' } }).png().toBuffer(), label: (p.label || '') + ' (missing)' }); }
  }
  const metas = await Promise.all(imgs.map(i => sharp(i.buf).metadata()));
  const W = metas.reduce((s, m) => s + m.width, 0) + pad * (imgs.length + 1);
  const totalH = H + labelH + pad;
  let x = pad; const comps = []; const labels = [];
  for (let i = 0; i < imgs.length; i++) {
    comps.push({ input: imgs[i].buf, left: x, top: pad });
    labels.push(`<text x="${x + metas[i].width / 2}" y="${totalH - 7}" font-family="sans-serif" font-size="15" fill="#cde" text-anchor="middle">${imgs[i].label}</text>`);
    x += metas[i].width + pad;
  }
  const svg = `<svg width="${W}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`;
  const out = await sharp({ create: { width: W, height: totalH, channels: 3, background: '#0e1116' } })
    .composite([...comps, { input: Buffer.from(svg), left: 0, top: 0 }]).png().toBuffer();
  if (outPath) { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, out); }
  return out;
}

// Side-by-side sheet: [ real | render ], each labeled. Returns PNG buffer + path.
export async function comparisonSheet(realPath, renderPath, outPath, labelA = 'REAL PHOTO (target)', labelB = 'YOUR 3D RENDER') {
  const H = 512, pad = 8, labelH = 26;
  const a = await sharp(realPath).resize({ height: H, fit: 'inside' }).toBuffer();
  const b = await sharp(renderPath).resize({ height: H, fit: 'inside' }).toBuffer();
  const am = await sharp(a).metadata(), bm = await sharp(b).metadata();
  const W = am.width + bm.width + pad * 3;
  const totalH = H + labelH + pad * 2;
  const svg = `<svg width="${W}" height="${totalH}"><rect width="100%" height="100%" fill="#0e1116"/>
    <text x="${pad + am.width / 2}" y="${totalH - 8}" font-family="sans-serif" font-size="15" fill="#7ee" text-anchor="middle">${labelA}</text>
    <text x="${pad * 2 + am.width + bm.width / 2}" y="${totalH - 8}" font-family="sans-serif" font-size="15" fill="#fe9" text-anchor="middle">${labelB}</text></svg>`;
  const sheet = await sharp({ create: { width: W, height: totalH, channels: 3, background: '#0e1116' } })
    .composite([
      { input: a, left: pad, top: pad },
      { input: b, left: pad * 2 + am.width, top: pad },
      { input: Buffer.from(svg), left: 0, top: 0 },
    ]).png().toBuffer();
  if (outPath) { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, sheet); }
  return { buf: sheet, path: outPath };
}
