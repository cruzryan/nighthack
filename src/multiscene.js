// EXHAUSTIVE scene reconstruction: don't miss 90% of the objects.
//   1) GRID CENSUS — scan every region of the photo so nothing is skipped
//   2) BUILD EACH — real geometry per object (people become humanoids)
//   3) COMPLETENESS LOOP — keep asking "what's in the photo but NOT in my render?"
//      and add it, until two rounds find nothing new ("verify 10x more").
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { visionJSON } from './openai.js';
import { perceiveRich } from './agents.js';
import { normalizeScene, worldAABB, groundScene, scaleBodies, offsetBodies, ensureArticulation, fitCamera, countBodies } from './scene.js';
import { renderStates, standardStates } from './render.js';
import { bufToDataUri, fileToScaledDataUri } from './imageutil.js';

const hex = (v, d) => (typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test((v || '').trim())) ? (v.trim()[0] === '#' ? v.trim() : '#' + v.trim()) : d;
const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
let _uid = 0; const uid = p => `${p}_${(_uid++).toString(36)}`;

// ---- 1) exhaustive grid census -------------------------------------------------

const CENSUS_SYS = `You are an exhaustive object detector for 3D reconstruction. List EVERY distinct physical object visible — do NOT summarize or skip anything. Include people, machines, tanks, bottles/containers, pipes/hoses, conveyors, boxes/crates, control panels, cabinets, beams/rails, wall panels, tools, lights. Small and background objects count.
Reply ONLY JSON: { "objects": [ {
  "label": string,
  "category": "person|machine|tank|bottle|container|box|pipe|conveyor|beam|panel|cabinet|tool|light|structure|other",
  "bbox": [x0,y0,x1,y1],   // fractions 0..1 within THIS image
  "color": "#rrggbb",       // dominant color
  "size_m": n,              // largest real dimension in meters (person~1.7, tank~2, bottle~0.3, box~0.4, pipe by length)
  "moves": "none|conveyor|spin|oscillate|slide"
} ] }`;

async function censusCell(imgPath, cell, model) {
  const m = await sharp(imgPath).metadata(); const W = m.width, H = m.height;
  const [cx0, cy0, cx1, cy1] = cell;
  const left = Math.floor(cx0 * W), top = Math.floor(cy0 * H);
  const width = Math.max(16, Math.floor((cx1 - cx0) * W)), height = Math.max(16, Math.floor((cy1 - cy0) * H));
  const buf = await sharp(imgPath).extract({ left, top, width: Math.min(width, W - left), height: Math.min(height, H - top) }).resize({ width: 768, height: 768, fit: 'inside' }).png().toBuffer();
  try {
    const { json } = await visionJSON({ model, system: CENSUS_SYS, user: 'List EVERY object in this image region. Be exhaustive. ONLY JSON.', images: [bufToDataUri(buf)], maxTokens: 2500 });
    return (json.objects || []).map(o => ({ ...o, bbox: mapBbox(normBbox(o.bbox) || [0, 0, 1, 1], cell) }));
  } catch { return []; }
}

function mapBbox(bb, cell) {
  if (!Array.isArray(bb) || bb.length !== 4) return [cell[0], cell[1], cell[2], cell[3]];
  const [cx0, cy0, cx1, cy1] = cell, w = cx1 - cx0, h = cy1 - cy0;
  return [cx0 + bb[0] * w, cy0 + bb[1] * h, cx0 + bb[2] * w, cy0 + bb[3] * h];
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  const iw = Math.max(0, x1 - x0), ih = Math.max(0, y1 - y0), inter = iw * ih;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

function normBbox(bb) {
  if (!Array.isArray(bb) || bb.length !== 4 || bb.some(v => !isFinite(v))) return null;
  let b = bb.slice();
  // some models return PIXELS not 0..1 fractions — normalize if clearly out of range
  const mx = Math.max(...b.map(Math.abs));
  if (mx > 1.5) b = b.map(v => v / mx);
  b = b.map(v => Math.max(0, Math.min(1, v)));
  const x0 = Math.min(b[0], b[2]), x1 = Math.max(b[0], b[2]), y0 = Math.min(b[1], b[3]), y1 = Math.max(b[1], b[3]);
  return [x0, y0, x1, y1];
}
function dedupe(objs) {
  const clean = objs.map(o => ({ ...o, bbox: normBbox(o.bbox) })).filter(o => o.bbox && (o.bbox[2] - o.bbox[0]) > 0.008 && (o.bbox[3] - o.bbox[1]) > 0.008)
    .map(o => ({ label: (o.label || 'object').toString().slice(0, 40), category: (o.category || 'other').toLowerCase(), bbox: o.bbox, color: hex(o.color, '#9aa3ad'), size_m: Math.min(4, Math.max(0.03, num(o.size_m, 0.3))), moves: ['conveyor', 'spin', 'oscillate', 'slide'].includes(o.moves) ? o.moves : 'none' }));
  clean.sort((a, b) => ((b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])) - ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1])));
  const kept = [];
  for (const o of clean) { if (!kept.some(k => iou(k.bbox, o.bbox) > 0.55)) kept.push(o); }
  return kept.slice(0, 120);
}

export async function censusScene({ src, model, onProgress = () => {} }) {
  // global pass (big objects) + a 3x3 grid (nothing skipped)
  const cells = [[0, 0, 1, 1]];
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) cells.push([gx / 3 - 0.02, gy / 3 - 0.02, (gx + 1) / 3 + 0.02, (gy + 1) / 3 + 0.02].map((v, i) => Math.max(0, Math.min(1, v))));
  onProgress({ phase: 'detect', msg: `Exhaustive census: scanning ${cells.length} regions…` });
  const all = (await Promise.all(cells.map(c => censusCell(src.path, c, model)))).flat();
  return dedupe(all);
}

// ---- 2) build each object ------------------------------------------------------

function humanoid(o, x, z) {
  const h = Math.min(2.0, Math.max(1.2, o.size_m || 1.7)), coat = o.color, skin = '#cfa47a', dark = '#333a44';
  const legH = h * 0.46, torsoH = h * 0.34, torsoW = h * 0.30, headR = h * 0.065, armH = h * 0.34;
  const cy = legH + torsoH / 2, id = uid('person');
  return [
    { id, label: o.label || 'person', geometry: { type: 'capsule', radius: torsoW / 2, height: torsoH + torsoW }, material: { color: coat, kind: 'fabric' }, position: [x, cy, z],
      children: [{ id: id + '_head', geometry: { type: 'sphere', radius: headR }, material: { color: skin, kind: 'plastic' }, position: [0, torsoH / 2 + headR * 0.8, 0] }] },
    { id: id + '_armL', geometry: { type: 'capsule', radius: h * 0.028, height: armH }, material: { color: coat, kind: 'fabric' }, position: [x - torsoW / 2, cy, z], rotation_deg: [0, 0, 8] },
    { id: id + '_armR', geometry: { type: 'capsule', radius: h * 0.028, height: armH }, material: { color: coat, kind: 'fabric' }, position: [x + torsoW / 2, cy, z], rotation_deg: [0, 0, -8] },
    { id: id + '_legL', geometry: { type: 'capsule', radius: h * 0.04, height: legH }, material: { color: dark, kind: 'fabric' }, position: [x - torsoW * 0.22, legH / 2, z] },
    { id: id + '_legR', geometry: { type: 'capsule', radius: h * 0.04, height: legH }, material: { color: dark, kind: 'fabric' }, position: [x + torsoW * 0.22, legH / 2, z] },
  ];
}

// Only the genuinely-simple shapes stay as one deterministic primitive; everything
// with internal structure (machine/cabinet/panel/tool/light/structure/other) gets
// DRILLED INTO with a real per-object reconstruction (its own decomposed sub-model).
const SIMPLE = new Set(['bottle', 'container', 'box', 'tank', 'pipe', 'beam', 'conveyor']);

// bounded-concurrency parallel map (the "agents" — one per part, N at a time)
async function mapPool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = []; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

function primFor(o, x, z) {
  const s = Math.min(4, Math.max(0.04, o.size_m || 0.3)), c = o.color, id = uid(o.category);
  const ar = (o.bbox[2] - o.bbox[0]) / Math.max(0.01, (o.bbox[3] - o.bbox[1])); // wide vs tall
  const base = (geom, extra = {}) => [{ id, label: o.label, geometry: geom, material: { color: c, kind: kindFor(o.category), ...(extra.mat || {}) }, position: [x, extra.y != null ? extra.y : s / 2, z], ...(extra.motion ? { motion: extra.motion } : {}), ...(extra.rot ? { rotation_deg: extra.rot } : {}), ...(extra.children ? { children: extra.children } : {}) }];
  switch (o.category) {
    case 'bottle': case 'container': return base({ type: 'lathe', radius: s * 0.28, height: s, profile: [[0.9, 0], [0.95, 0.55], [0.35, 0.72], [0.32, 0.9], [0.5, 1]] });
    case 'tank': return base({ type: 'cylinder', radius: s * 0.32, height: s }, { children: [{ id: id + '_top', geometry: { type: 'cone', radius: s * 0.32, height: s * 0.3 }, material: { color: c, kind: 'metal' }, position: [0, s * 0.55, 0] }] });
    case 'pipe': return base({ type: 'cylinder', radius: Math.max(0.02, s * 0.06), height: s }, { rot: ar > 1.4 ? [0, 0, 90] : [0, 0, 0], y: ar > 1.4 ? Math.max(0.3, s * 0.4) : s / 2 });
    case 'beam': return base({ type: 'box', size: ar > 1 ? [s, s * 0.06, s * 0.06] : [s * 0.06, s, s * 0.06] }, { y: ar > 1 ? Math.max(0.5, s * 0.5) : s / 2 });
    case 'box': return base({ type: 'box', size: [s * 0.9, s * 0.7, s * 0.9] }, { y: s * 0.35 });
    case 'panel': case 'structure': return base({ type: 'box', size: [ar >= 1 ? s : s * 0.5, ar >= 1 ? s * 0.6 : s, 0.08] }, { y: (ar >= 1 ? s * 0.6 : s) / 2 });
    case 'light': return base({ type: 'box', size: [s, 0.06, 0.3] }, { y: 2.6, mat: { emissive: '#ffffff' } });
    case 'conveyor': {
      const cargo = [-0.3, 0, 0.3].map((zz, k) => ({ id: id + '_c' + k, geometry: { type: 'box', size: [s * 0.12, s * 0.12, s * 0.12] }, material: { color: '#b5651d', kind: 'plastic' }, position: [0, s * 0.1, zz * s] }));
      return base({ type: 'box', size: [s * 0.35, s * 0.08, s * 1.4] }, { y: 0.5, motion: { type: 'conveyor', axis: [0, 0, 1], rate: 0.4 }, children: cargo });
    }
    default: return base({ type: 'box', size: [s * 0.8, s, s * 0.8] }, { y: s / 2 });
  }
}
function kindFor(cat) { return ({ bottle: 'plastic', container: 'plastic', tank: 'metal', pipe: 'metal', beam: 'metal', panel: 'metal', box: 'painted', conveyor: 'metal', light: 'plastic', machine: 'metal', cabinet: 'metal' })[cat] || 'metal'; }

async function buildOne(o, src, model, browser, runDir, allowPerceive) {
  const centerX = Math.max(0, Math.min(1, (o.bbox[0] + o.bbox[2]) / 2)), centerY = Math.max(0, Math.min(1, (o.bbox[1] + o.bbox[3]) / 2));
  // spread across a large floor so objects don't collapse into a central pile;
  // image row -> depth (bottom of image = foreground/nearer the camera).
  const sceneW = 14, sceneD = 11;
  const x = (centerX - 0.5) * sceneW, z = (centerY - 0.45) * sceneD;
  if (o.category === 'person') return humanoid(o, x, z);
  if (SIMPLE.has(o.category)) { const b = primFor(o, x, z); if (o.moves !== 'none' && !b[0].motion) b[0].motion = { type: o.moves, axis: [0, 1, 0], rate: 1.2 }; return b; }
  if (!allowPerceive) return primFor(o, x, z);
  // complex machine / cabinet / robot / other-big → real perceive of its crop
  try {
    const m = await sharp(src.path).metadata();
    const buf = await sharp(src.path).extract({ left: Math.floor(o.bbox[0] * m.width), top: Math.floor(o.bbox[1] * m.height), width: Math.max(16, Math.floor((o.bbox[2] - o.bbox[0]) * m.width)), height: Math.max(16, Math.floor((o.bbox[3] - o.bbox[1]) * m.height)) }).resize({ width: 1024, height: 1024, fit: 'inside' }).png().toBuffer();
    const { spec } = await perceiveRich({ images: [bufToDataUri(buf)], userHint: `a "${o.label}" (${o.category}) — isolated. Reconstruct it in detail.`, model });
    ensureArticulation(spec); groundScene(spec);
    const bb = worldAABB(spec); const maxDim = Math.max(bb.hi[0] - bb.lo[0], bb.hi[1] - bb.lo[1], bb.hi[2] - bb.lo[2]) || 0.3;
    scaleBodies(spec.bodies, Math.min(4, Math.max(0.05, o.size_m)) / maxDim); groundScene(spec);
    offsetBodies(spec.bodies, x, 0, z);
    return spec.bodies;
  } catch { return primFor(o, x, z); }
}

async function buildAll(objs, src, model, browser, runDir, onProgress, tag = 'built') {
  // DRILL INTO every structured object (cap 80 real per-object reconstructions);
  // simple shapes are instant primitives.
  let perceives = 0;
  const allow = objs.map(o => {
    const complex = !SIMPLE.has(o.category) && o.category !== 'person';
    if (complex && perceives < 80) { perceives++; return true; }
    return false;
  });
  // bounded-parallel map — up to 16 per-object "agents" at once; progress as each finishes
  let done = 0; const total = objs.length;
  const results = await mapPool(objs, 16, async (o, i) => {
    const r = await buildOne(o, src, model, browser, runDir, allow[i]);
    done++; onProgress({ phase: 'object', done, total, msg: `${tag}: ${o.label}` });
    return r;
  });
  const out = [];
  const index = [];  // per-object: source bbox + the ids/pos of the bodies it produced (for micro-verify)
  for (let i = 0; i < objs.length; i++) {
    const bs = results[i] || []; out.push(...bs);
    if (bs.length && bs[0].position) index.push({ bbox: objs[i].bbox, label: objs[i].label, category: objs[i].category, size: Math.min(4, Math.max(0.12, objs[i].size_m || 0.5)), ids: bs.map(b => b.id), pos: bs[0].position.slice() });
  }
  return { bodies: out, index };
}

// ---- 2.5) deterministic sanitize: kill hallucinated floating rods, ground junk --
function bodyDims(b) {
  const g = b.geometry || {};
  if (g.type === 'box' || g.type === 'tray' || g.type === 'frame' || g.type === 'plane') { const s = g.size || [0.2, 0.2, 0.2]; return { h: s[1], dims: s.slice() }; }
  if (g.type === 'sphere') { const d = 2 * (g.radius || 0.1); return { h: d, dims: [d, d, d] }; }
  if (g.type === 'torus') { const d = 2 * ((g.radius || 0.1) + (g.tube || 0.03)); return { h: 2 * (g.tube || 0.03), dims: [d, 2 * (g.tube || 0.03), d] }; }
  if (g.type === 'extrude') { const xs = (g.shape || [[0, 0]]).map(p => p[0]), ys = (g.shape || [[0, 0]]).map(p => p[1]); const w = (Math.max(...xs) - Math.min(...xs)) || 0.1, ht = (Math.max(...ys) - Math.min(...ys)) || 0.1; return { h: ht, dims: [w, ht, g.depth || 0.05] }; }
  const r = g.radius || 0.05, h = g.height || 0.2; return { h, dims: [2 * r, h, 2 * r] }; // cyl/cone/capsule/lathe
}

// Remove hallucinated stray "lines" (thin, elongated, floating rods) and drop
// clearly-floating objects onto the floor. Deterministic, runs before verify.
function sanitizeScene(spec) {
  groundScene(spec);
  const kept = [];
  for (const b of spec.bodies || []) {
    const { h, dims } = bodyDims(b);
    const maxDim = Math.max(...dims), minDim = Math.min(...dims), bottom = b.position[1] - h / 2;
    const thinRod = (maxDim / Math.max(0.002, minDim)) > 9 && minDim < 0.07;   // a "line"
    if (thinRod && bottom > 0.4) continue;                                     // floating stray line -> delete
    if (bottom > 0.8) b.position = [b.position[0], h / 2, b.position[2]];      // clearly floating -> drop to floor
    kept.push(b);
  }
  const removed = (spec.bodies || []).length - kept.length;
  spec.bodies = kept;
  return removed;
}

// ---- 2.6) PARALLEL fly-around verifier: critics inspect from many angles at once
// and flag hallucinated / junk objects to delete (the "verify what's wrong" system).
async function criticChunk(chunk, src, renderUris, model) {
  const sys = `You verify a 3D reconstruction against its reference photo. IMAGE 1 = the real photo. The other images = renders of the reconstruction from several angles (front/left/right/top). You are given a SUBSET of the reconstruction's objects (id | label | position | size). Flag the ones that are HALLUCINATED or JUNK — stray thin lines/rods, random floating boxes, things with no counterpart in the photo, obvious garbage. Be conservative: only remove clear junk; when unsure, KEEP it.
Reply ONLY JSON: { "remove": ["id", ...] }`;
  const user = `Objects (id | label | pos[x,y,z] | size_m):\n${chunk.map(o => `${o.id} | ${o.label} | [${o.pos}] | ${o.size}`).join('\n')}\n\nWhich of THESE are hallucinated/junk not supported by the photo? ONLY JSON {"remove":[ids]}.`;
  try { const { json } = await visionJSON({ model, system: sys, user, images: [src.dataUri, ...renderUris], maxTokens: 900 }); return Array.isArray(json.remove) ? json.remove : []; } catch { return []; }
}

async function verifyAndRepair({ spec, src, renderUris, model, onProgress }) {
  const objs = (spec.bodies || []).map(b => { const { dims } = bodyDims(b); return { id: b.id, label: b.label || b.geometry.type, pos: b.position.map(v => +v.toFixed(1)), size: +Math.max(...dims).toFixed(2) }; });
  const chunks = []; for (let i = 0; i < objs.length; i += 18) chunks.push(objs.slice(i, i + 18));
  onProgress({ phase: 'verify', msg: `Fly-around verify: ${chunks.length} critics inspecting ${objs.length} objects in parallel…` });
  const lists = await Promise.all(chunks.map(ch => criticChunk(ch, src, renderUris, model)));   // parallel critics
  const remove = new Set(); lists.flat().forEach(id => remove.add(id));
  if (remove.size) spec.bodies = spec.bodies.filter(b => !remove.has(b.id));
  return remove.size;
}

// PER-OBJECT micro-verify: zoom the camera into each object (2 angles), compare it
// to its OWN crop of the source photo, in parallel; delete objects that don't match.
async function microJudge(e, cropUri, ra, rb) {
  if (!cropUri || !ra) return true; // can't judge -> keep
  // CONSERVATIVE: a crude primitive NEVER matches a real machine's detail — that's
  // expected. Only delete a reconstruction placed over EMPTY space (a hallucination)
  // or obvious stray junk. Bias hard toward KEEP.
  const sys = `You decide KEEP or DELETE for ONE object in a 3D reconstruction. IMAGE 1 = a crop of the REAL photo at this object's location (labelled "${e.label}"). IMAGE 2/3 = the crude blocky 3D reconstruction of it. The 3D is ONLY a rough primitive approximation — crude/blocky/wrong-detail is EXPECTED and FINE, never a reason to delete.
KEEP if IMAGE 1 shows ANY real object, equipment, person, container, or structure at that spot (even partially, even if the 3D is a crude box).
DELETE only if IMAGE 1 is essentially EMPTY floor / blank wall / plain background with no object there (so the 3D object is a hallucination over nothing), OR the reconstruction is obvious stray junk (a thin floating line/slab).
When unsure, KEEP. Reply ONLY JSON: { "keep": true|false }`;
  try {
    const { json } = await visionJSON({ model: 'gpt-4o-mini', system: sys, user: `Is there a real object at this location in the photo? Keep unless it's empty/junk. ONLY JSON {"keep":bool}.`, images: [cropUri, ra, rb].filter(Boolean), maxTokens: 60 });
    return json.keep !== false;
  } catch { return true; }
}

async function microVerify({ master, index, src, browser, runDir, onProgress }) {
  const alive = new Set((master.bodies || []).map(b => b.id));
  const items = index.filter(e => e.pos && e.ids.some(id => alive.has(id)));
  if (!items.length) return 0;
  onProgress({ phase: 'micro', total: items.length, done: 0, msg: `Micro-verify: zooming into ${items.length} objects (parallel)…` });
  // 1) render two zoomed angles per object (one browser page; fast)
  const states = [];
  items.forEach((e, i) => {
    const d = Math.max(0.4, e.size * 2.4);
    states.push({ name: `m${i}a`, focus: e.pos, az: 25, el: 18, dist: d, plain: true });
    states.push({ name: `m${i}b`, focus: e.pos, az: -55, el: 42, dist: d, plain: true });
  });
  const shots = await renderStates(master, path.join(runDir, 'micro'), states, { browser, width: 384, height: 384, fit: false });
  const shotUri = {};
  await Promise.all(shots.map(async s => { shotUri[s.name] = await fileToScaledDataUri(s.path, 384); }));
  // 2) crop the source per object + judge in parallel (cheap model)
  const meta = await sharp(src.path).metadata();
  let done = 0;
  const verdicts = await mapPool(items, 16, async (e, i) => {
    let cropUri = null;
    try {
      const [x0, y0, x1, y1] = e.bbox;
      const left = Math.floor(x0 * meta.width), top = Math.floor(y0 * meta.height);
      const w = Math.max(16, Math.floor((x1 - x0) * meta.width)), h = Math.max(16, Math.floor((y1 - y0) * meta.height));
      cropUri = bufToDataUri(await sharp(src.path).extract({ left, top, width: Math.min(w, meta.width - left), height: Math.min(h, meta.height - top) }).resize({ width: 384, height: 384, fit: 'inside' }).png().toBuffer());
    } catch {}
    const keep = await microJudge(e, cropUri, shotUri[`m${i}a`], shotUri[`m${i}b`]);
    done++; onProgress({ phase: 'micro', total: items.length, done, msg: `Micro-verify ${done}/${items.length}` });
    return { e, keep };
  });
  const del = new Set();
  for (const v of verdicts) if (v && !v.keep) v.e.ids.forEach(id => del.add(id));
  if (del.size) master.bodies = master.bodies.filter(b => !del.has(b.id));
  return del.size;
}

// ---- 3) completeness loop ------------------------------------------------------

async function findMissing({ src, renderUris, presentLabels, model }) {
  const sys = `IMAGE 1 = the REAL reference photo. The other images = the CURRENT 3D reconstruction render.
The reconstruction currently contains these objects: ${presentLabels.slice(0, 120).join(', ') || '(none)'}.
List every object VISIBLE IN THE REFERENCE that is MISSING from the render (or grossly under-represented). Be thorough and specific — include people, pipes, hoses, small machines, background structures, tanks, panels, tools. Ignore exact framing/lighting.
Reply ONLY JSON: { "missing": [ { "label": string, "category": "person|machine|tank|bottle|container|box|pipe|conveyor|beam|panel|cabinet|tool|light|structure|other", "bbox":[x0,y0,x1,y1], "color":"#rrggbb", "size_m": n, "moves":"none|conveyor|spin|oscillate|slide" } ] }
If truly nothing significant is missing, return {"missing":[]}.`;
  try {
    const { json } = await visionJSON({ model, system: sys, user: 'What is in the reference but missing from the render? ONLY JSON.', images: [src.dataUri, ...renderUris], maxTokens: 2500 });
    return dedupe(json.missing || []);
  } catch { return []; }
}

function compose(bodies, name) {
  return normalizeScene({
    meta: { name },
    camera: { azimuth_deg: 32, elevation_deg: 20, fov_deg: 48 },
    environment: { background: '#e9edf2', ground: { color: '#b9bfc6', visible: true } },
    bodies,
  });
}

export async function reconstructScene({ images, prompt = '', runDir, model, browser, maxComplete = 3, onProgress = () => {} }) {
  fs.mkdirSync(runDir, { recursive: true });
  const src = images[0];
  const name = (prompt && prompt.slice(0, 40)) || 'scene';

  const census = await censusScene({ src, model, onProgress });
  onProgress({ phase: 'detected', msg: `Census found ${census.length} objects. Building each in parallel…`, objects: census.map(o => o.label), total: census.length });
  const built0 = await buildAll(census, src, model, browser, runDir, onProgress);
  let bodies = built0.bodies; const index = built0.index;
  let master = compose(bodies, name);

  // COMPLETENESS LOOP — keep adding what's missing until 2 dry rounds
  let dry = 0, present = census.map(o => o.label);
  for (let round = 1; round <= maxComplete; round++) {
    fitCamera(master);
    const az = master.camera.azimuth_deg, el = master.camera.elevation_deg, d = master.camera.distance;
    const shots = await renderStates(master, path.join(runDir, `c${round}`), [
      { name: 'a', camera: [az, el, d], close: true, plain: true },
      { name: 'b', camera: [az + 55, el, d], close: true, plain: true },
    ], { browser, width: 640, height: 640, fit: false });
    const renderUris = await Promise.all(shots.map(s => fileToScaledDataUri(s.path, 700)));
    onProgress({ phase: 'complete', round, msg: `Completeness pass ${round}: what's still missing?` });
    const missing = await findMissing({ src, renderUris, presentLabels: present, model });
    // drop ones we already effectively have (bbox overlap with an existing census bbox)
    const fresh = missing.filter(mo => !census.some(c => iou(c.bbox, mo.bbox) > 0.5));
    if (!fresh.length) { dry++; onProgress({ phase: 'complete', round, msg: `Pass ${round}: nothing new (${dry}/2)` }); if (dry >= 2) break; continue; }
    dry = 0;
    census.push(...fresh); present.push(...fresh.map(o => o.label));
    const add = await buildAll(fresh, src, model, browser, runDir, onProgress, `added(r${round})`);
    bodies.push(...add.bodies); index.push(...add.index); master = compose(bodies, name);
    onProgress({ phase: 'complete', round, msg: `Pass ${round}: added ${fresh.length} (${countBodies(master).bodies} parts total)` });
  }

  // CLEAN + PER-OBJECT MICRO-VERIFY: zoom into EACH object, compare it to its own
  // source-photo crop from 2 angles, in parallel; delete what doesn't match.
  onProgress({ phase: 'sanitize', msg: 'Cleaning stray/floating hallucinations…' });
  const strayRemoved = sanitizeScene(master);
  const removedMicro = await microVerify({ master, index, src, browser, runDir, onProgress });
  sanitizeScene(master);
  onProgress({ phase: 'verified', msg: `Verify: removed ${strayRemoved} stray + ${removedMicro} mismatched object(s)` });

  fitCamera(master);
  await renderStates(master, path.join(runDir, 'final'), standardStates(), { browser });
  fs.writeFileSync(path.join(runDir, 'scene.json'), JSON.stringify(master, null, 2));
  const c = countBodies(master);
  onProgress({ phase: 'done', msg: `Scene built: ${census.length} objects, ${c.bodies} parts`, bodies: c.bodies });
  return { spec: master, objects: census.length, viewerPath: path.join(runDir, 'final', 'index.html') };
}
