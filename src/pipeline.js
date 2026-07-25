// The agentic reconstruction loop:
//   perceive(image[s]) -> render -> critique(render vs photo) -> refine -> repeat
// until the critic's visual score plateaus/passes, then a final render.
// Also exposes refineScene() for conversational, post-hoc edits (+ new images).
import fs from 'node:fs';
import path from 'node:path';
import { RUNS, MODEL, log } from './config.js';
import { perceive, critique, refine } from './agents.js';
import { buildObject } from './build.js';
import { renderStates, standardStates, launchBrowser } from './render.js';
import { comparisonSheet, fileToScaledDataUri } from './imageutil.js';
import { countBodies, fitCamera, repairDrawers, ensureArticulation } from './scene.js';
import { matchScore } from './metric.js';

// rough price table ($/1M tokens) for cost accounting; updated from research.
const PRICES = {
  'gpt-4o-mini': [0.15, 0.60], 'gpt-4.1-nano': [0.10, 0.40], 'gpt-4.1-mini': [0.40, 1.60],
  'gpt-4o': [2.50, 10.0], 'gpt-5-nano': [0.05, 0.40], 'gpt-5-mini': [0.25, 2.0], 'gpt-5.1': [1.25, 10.0],
};
function cost(usage, model) {
  const p = PRICES[model] || PRICES['gpt-4o-mini'];
  return ((usage?.prompt_tokens || 0) * p[0] + (usage?.completion_tokens || 0) * p[1]) / 1e6;
}

export async function loadImageInputs(paths) {
  const out = [];
  for (const p of paths) out.push({ path: p, dataUri: await fileToScaledDataUri(p, 768) });
  return out;
}

// Deterministic camera-pose alignment: search a small (az,el) grid around the
// model's estimate and keep the pose whose white-bg silhouette best matches the
// photo. Fixes viewpoint mismatch (the main drag on shape IoU) for free.
async function alignCamera(spec, photoPath, dir, browser) {
  fitCamera(spec);
  const az0 = spec.camera.azimuth_deg, dist = spec.camera.distance;
  const azs = [az0 - 28, az0 - 14, az0, az0 + 14, az0 + 28];
  const els = [8, 16, 26];
  const states = [];
  let k = 0;
  for (const a of azs) for (const e of els) states.push({ name: `p${k++}`, camera: [a, e, dist], close: true, plain: true, _az: a, _el: e });
  const shots = await renderStates(spec, dir, states, { browser, width: 480, height: 480, fit: false });
  let best = { score: -1, az: az0, el: spec.camera.elevation_deg };
  for (let i = 0; i < states.length; i++) {
    const m = await matchScore(photoPath, shots[i].path);
    if (m.score > best.score) best = { score: m.score, az: states[i]._az, el: states[i]._el };
  }
  spec.camera.azimuth_deg = best.az; spec.camera.elevation_deg = best.el;
  return best;
}

// Render the ref views needed by the critic + a white-bg "plain" shot for the
// deterministic metric; returns {closed, open, plain}.
async function renderForCritique(spec, dir, browser) {
  const shots = await renderStates(spec, dir, [
    { name: 'ref_closed', view: 'ref', close: true },
    { name: 'ref_open', view: 'ref', open: true },
    { name: 'ref_plain', view: 'ref', close: true, plain: true },
  ], { browser });
  const f = n => shots.find(s => s.name === n).path;
  return { closed: f('ref_closed'), open: f('ref_open'), plain: f('ref_plain') };
}

// v3: single-object reconstruction = the render→judge→patch build loop.
export async function reconstruct({ images, prompt = '', runDir, model = MODEL, maxIters = 5, browser, onProgress = () => {} }) {
  const ownBrowser = !browser; if (ownBrowser) browser = await launchBrowser();
  try {
    const r = await buildObject({ images, userHint: prompt, model, runDir, browser, maxRounds: Math.min(12, Math.max(3, maxIters)), onProgress });
    return { spec: r.spec, score: r.fidelity, history: r.history, cost: r.cost, runDir, viewerPath: r.viewerPath };
  } finally {
    if (ownBrowser) await browser.close();
  }
}

// Conversational edit: apply a user message (+optional new images) to an existing spec.
export async function refineScene({ spec, userMessage, images = [], runDir, model = MODEL, browser, autoCritique = true, onProgress = () => {} }) {
  const ownBrowser = !browser; if (ownBrowser) browser = await launchBrowser();
  let totalCost = 0;
  try {
    onProgress({ phase: 'refine', msg: 'Applying your change…' });
    const dataUris = images.map(i => i.dataUri);
    const rf = await refine({ spec, instructions: '', userMessage, images: dataUris, model });
    ensureArticulation(rf.spec);
    totalCost += cost(rf.usage, model);
    let newSpec = rf.spec, score = null;

    const dir = path.join(runDir, 'edit_' + Date.now().toString(36));
    if (autoCritique && images.length) {
      // if the user added a new photo, score against it and do one auto-fix pass
      const { closed } = await renderForCritique(newSpec, dir, browser);
      const cr = await critique({ realImage: dataUris[0], renderImages: [await fileToScaledDataUri(closed, 768)], spec: newSpec, model });
      totalCost += cost(cr.usage, model);
      score = cr.score;
      onProgress({ phase: 'scored', score, msg: `New view matched at ${(score * 100).toFixed(0)}%` });
    }
    const finalDir = path.join(runDir, 'final');
    await renderStates(newSpec, finalDir, standardStates(), { browser });
    fs.writeFileSync(path.join(runDir, 'scene.json'), JSON.stringify(newSpec, null, 2));
    onProgress({ phase: 'done', score, cost: totalCost, msg: 'Updated' });
    return { spec: newSpec, score, cost: totalCost, viewerPath: path.join(finalDir, 'index.html') };
  } finally {
    if (ownBrowser) await browser.close();
  }
}

// ---- CLI entry: node src/pipeline.js <imageURLorPath> [prompt] ----
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  const prompt = process.argv.slice(3).join(' ');
  if (!arg) { console.error('usage: node src/pipeline.js <imageURLorPath> [prompt]'); process.exit(1); }
  const { fetchImage } = await import('./imageutil.js');
  const runDir = path.join(RUNS, 'cli_' + Date.now().toString(36));
  let imgPath = arg;
  if (/^https?:/.test(arg)) { imgPath = path.join(runDir, 'input.png'); await fetchImage(arg, imgPath); }
  const images = await loadImageInputs([imgPath]);
  log(`model=${MODEL}  run=${runDir}`);
  const res = await reconstruct({ images, prompt, runDir, onProgress: p => log(`  · ${p.msg}`) });
  log(`viewer: ${res.viewerPath}`);
}
