// Deterministic visual-match reward between the source photo and a render.
// The VLM critic is a coarse, noisy judge; this gives a SMOOTH, consistent
// gradient (verifiable reward) so the refine loop can actually hill-climb.
// Components (all camera-robust-ish): foreground color, silhouette shape (IoU),
// bbox aspect ratio, and fill fraction.
import sharp from 'sharp';

async function toMaskData(input, size = 160) {
  // returns { w,h, gray:Uint8, rgb:Uint8Array(w*h*3), mask:Uint8, bbox, meanColor, area }
  const img = sharp(input).resize({ width: size, height: size, fit: 'inside' }).removeAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  // estimate background from the 4 corners (median-ish = average of corners)
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  let br = 0, bg = 0, bb = 0;
  for (const [x, y] of corners) { const i = (y * w + x) * ch; br += data[i]; bg += data[i + 1]; bb += data[i + 2]; }
  br /= 4; bg /= 4; bb /= 4;
  const mask = new Uint8Array(w * h);
  let minx = w, miny = h, maxx = 0, maxy = 0, area = 0, mr = 0, mg = 0, mb = 0;
  const tol = 42; // color distance from background to count as foreground
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * ch;
    const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d > tol) {
      mask[y * w + x] = 1; area++;
      minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
      mr += data[i]; mg += data[i + 1]; mb += data[i + 2];
    }
  }
  if (area < 8) return { w, h, mask, bbox: [0, 0, w, h], meanColor: [br, bg, bb], area: 0 };
  return { w, h, mask, bbox: [minx, miny, maxx, maxy], meanColor: [mr / area, mg / area, mb / area], area };
}

// resample a mask's bbox region into a fixed grid (stretch) -> Float array 0/1
function cropResample(m, N = 64) {
  const [x0, y0, x1, y1] = m.bbox; const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const out = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const sx = x0 + Math.floor((i / N) * bw), sy = y0 + Math.floor((j / N) * bh);
    out[j * N + i] = m.mask[sy * m.w + sx] || 0;
  }
  return out;
}

export async function matchScore(photoInput, renderInput) {
  const A = await toMaskData(photoInput), B = await toMaskData(renderInput);
  if (!A.area || !B.area) return { score: 0, color: 0, shape: 0, aspect: 0, fill: 0 };

  // color match (mean foreground RGB distance, normalized)
  const dc = Math.sqrt(A.meanColor.reduce((s, v, k) => s + (v - B.meanColor[k]) ** 2, 0));
  const color = Math.max(0, 1 - dc / 180);

  // silhouette shape IoU (position+scale normalized via bbox crop)
  const ca = cropResample(A), cb = cropResample(B); let inter = 0, uni = 0;
  for (let i = 0; i < ca.length; i++) { const a = ca[i], b = cb[i]; if (a | b) uni++; if (a & b) inter++; }
  const shape = uni ? inter / uni : 0;

  // bbox aspect ratio match
  const arA = (A.bbox[2] - A.bbox[0]) / Math.max(1, A.bbox[3] - A.bbox[1]);
  const arB = (B.bbox[2] - B.bbox[0]) / Math.max(1, B.bbox[3] - B.bbox[1]);
  const aspect = Math.min(arA, arB) / Math.max(arA, arB);

  // fill fraction match (area / bbox area) -> solidity
  const fillA = A.area / Math.max(1, (A.bbox[2] - A.bbox[0]) * (A.bbox[3] - A.bbox[1]));
  const fillB = B.area / Math.max(1, (B.bbox[2] - B.bbox[0]) * (B.bbox[3] - B.bbox[1]));
  const fill = 1 - Math.min(1, Math.abs(fillA - fillB));

  // NOTE: for photo-vs-procedural, silhouette IoU is dominated by framing/lighting
  // (img2threejs grimoire) — so weight it LIGHTLY and lean on palette + aspect.
  const score = 0.44 * color + 0.16 * shape + 0.26 * aspect + 0.14 * fill;
  return { score, color, shape, aspect, fill };
}
