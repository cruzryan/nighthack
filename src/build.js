// v3 build loop (img2threejs-style): perceive (no leakage) -> render from several
// angles -> a judge scores fidelity vs the reference AND returns a surgical patch
// -> apply -> repeat until it passes or plateaus. Then a gentle articulation pass
// so declared drawers/doors actually open.
import fs from 'node:fs';
import path from 'node:path';
import { MODEL, log } from './config.js';
import { perceiveRich, reviewAndPatch } from './agents.js';
import { renderStates, standardStates } from './render.js';
import { applyPatch, ensureArticulation, fitCamera, countBodies } from './scene.js';
import { fileToScaledDataUri, comparisonSheet } from './imageutil.js';

const clone = s => JSON.parse(JSON.stringify(s));

// FULL-COVERAGE render set for the judge: a 4-way orbit + top + the OPEN/MOVING
// state — so the judge sees everything the user can see (back, top, articulated,
// in-motion), not just 3 flattering front angles.
async function renderForJudge(spec, dir, browser) {
  fitCamera(spec);
  const az = spec.camera.azimuth_deg, el = spec.camera.elevation_deg, d = spec.camera.distance;
  const shots = await renderStates(spec, dir, [
    { name: 'ref', camera: [az, el, d], close: true, plain: true },
    { name: 'left', camera: [az - 60, el, d], close: true, plain: true },
    { name: 'right', camera: [az + 60, Math.max(8, el), d], close: true, plain: true },
    { name: 'back', camera: [az + 180, el, d], close: true, plain: true },
    { name: 'top', camera: [az, 72, d], close: true, plain: true },
    { name: 'action', camera: [az + 30, Math.max(12, el), d], open: true, time: 1.6, plain: true }, // articulated + mid-motion
  ], { browser, width: 560, height: 560, fit: false });
  return Promise.all(shots.map(s => fileToScaledDataUri(s.path, 560)));
}

export async function buildObject({ images, userHint = '', model = MODEL, runDir, browser, maxRounds = 7, threshold = 0.85, onProgress = () => {} }) {
  fs.mkdirSync(runDir, { recursive: true });
  const ref = images[0];
  let cost = 0;
  const price = /gpt-4\.1$/.test(model) ? [2, 8] : /gpt-4\.1-mini/.test(model) ? [0.4, 1.6] : /gpt-5\.1/.test(model) ? [1.25, 10] : [0.15, 0.6];
  const addCost = u => { cost += ((u?.prompt_tokens || 0) * price[0] + (u?.completion_tokens || 0) * price[1]) / 1e6; };

  onProgress({ phase: 'perceive', msg: 'Studying the image and blocking out the parts…' });
  let { spec, usage } = await perceiveRich({ images: [ref.dataUri], userHint, model });
  addCost(usage); ensureArticulation(spec);
  let best = { spec: clone(spec), fidelity: -1, round: 0, critFail: null };
  let stale = 0, rebuilds = 0;
  const history = [];

  for (let round = 1; round <= maxRounds; round++) {
    const idir = path.join(runDir, `r${round}`);
    const c = countBodies(spec);
    onProgress({ phase: 'render', round, msg: `Round ${round}: rendering ${c.bodies} parts from 6 views…` });
    const renders = await renderForJudge(spec, idir, browser);
    // keep a human-viewable comparison sheet
    const refShot = path.join(idir, 'shot_ref.png');
    if (fs.existsSync(refShot)) await comparisonSheet(ref.path, refShot, path.join(idir, 'compare.png')).catch(() => {});

    onProgress({ phase: 'judge', round, msg: `Round ${round}: judging against the reference…` });
    const rev = await reviewAndPatch({ spec, refImage: ref.dataUri, renderImages: renders, model, round });
    addCost(rev.usage);
    fs.writeFileSync(path.join(idir, 'spec.json'), JSON.stringify(spec, null, 2));
    fs.writeFileSync(path.join(idir, 'review.json'), JSON.stringify(rev, null, 2));
    const weakest = (rev.features || []).slice().sort((a, b) => (a.score || 0) - (b.score || 0))[0];
    const critFail = (rev.features || []).filter(f => f.critical && f.score < 0.7).map(f => f.name);
    history.push({ round, fidelity: rev.fidelity, summary: rev.summary, ops: rev.ops.length, features: rev.features, critFail });
    log(`round ${round}: fidelity=${rev.fidelity.toFixed(2)} verdict=${rev.verdict} ops=${rev.ops.length}${critFail.length ? ' CRIT-FAIL[' + critFail.join(',').slice(0, 40) + ']' : ''} — ${rev.summary.slice(0, 70)}`);
    onProgress({ phase: 'scored', round, fidelity: rev.fidelity, features: rev.features, msg: `Round ${round}: fidelity ${(rev.fidelity * 100).toFixed(0)}%${weakest ? ` · weakest: ${weakest.name} (${Math.round((weakest.score || 0) * 100)}%)` : ''}` });

    // prefer a spec with FEWER critical failures, then higher fidelity (per-feature, not just global)
    const bestCF = best.critFail ? best.critFail.length : Infinity;
    const better = critFail.length < bestCF || (critFail.length === bestCF && rev.fidelity > best.fidelity + 0.005);
    if (better) { best = { spec: clone(spec), fidelity: rev.fidelity, round, critFail }; stale = 0; }
    else stale++;
    if (rev.verdict === 'pass' || round === maxRounds) break;

    // ESCALATE instead of quitting: if patches have stalled while a critical feature is still
    // broken, don't just plateau — REBUILD from scratch with the judge's notes (refine-spec).
    if (stale >= 2 && critFail.length && rebuilds < 2) {
      rebuilds++;
      onProgress({ phase: 'rebuild', round, msg: `Round ${round}: stuck — rebuilding structure (${critFail.slice(0, 2).join(', ')})…` });
      const notes = `Your previous attempt FAILED these critical features: ${critFail.join('; ')}. ${rev.summary}. Rebuild the object correctly this time, paying special attention to those.`;
      try { const rb = await perceiveRich({ images: [ref.dataUri], userHint: (userHint ? userHint + '\n' : '') + notes, model }); addCost(rb.usage); spec = rb.spec; ensureArticulation(spec); stale = 0; continue; } catch { }
    }

    onProgress({ phase: 'refine', round, msg: `Round ${round}: applying ${rev.ops.length} fixes…` });
    spec = applyPatch(spec, rev.ops);
    ensureArticulation(spec);
  }

  // finalize on the best spec
  const finalDir = path.join(runDir, 'final');
  fitCamera(best.spec);
  await renderStates(best.spec, finalDir, standardStates(), { browser });
  fs.writeFileSync(path.join(runDir, 'scene.json'), JSON.stringify(best.spec, null, 2));
  onProgress({ phase: 'done', fidelity: best.fidelity, cost, msg: `Done — best fidelity ${(best.fidelity * 100).toFixed(0)}%` });
  return { spec: best.spec, fidelity: best.fidelity, score: best.fidelity, cost, history, viewerPath: path.join(finalDir, 'index.html') };
}
