import path from 'node:path';
import { ROOT, log } from '../src/config.js';
import { buildObject } from '../src/build.js';
import { loadImageInputs } from '../src/pipeline.js';
import { launchBrowser } from '../src/render.js';
import { montage } from '../src/imageutil.js';
const img = process.argv[2] || 'assets/dresser_34.png';
const model = process.env.MODEL || 'gpt-4.1';
const hint = process.argv[3] || '';   // NO leakage by default
const b = await launchBrowser();
const imgs = await loadImageInputs([path.join(ROOT, img)]);
const runDir = path.join(ROOT, 'runs', 'build_' + Date.now().toString(36));
log(`model=${model} img=${img} hint="${hint}"`);
const r = await buildObject({ images: imgs, userHint: hint, model, runDir, browser: b, maxRounds: 5, onProgress: p => log('  · ' + p.msg) });
await b.close();
await montage([
  { path: path.join(ROOT, img), label: 'SOURCE' },
  { path: path.join(runDir, 'final', 'shot_ref_closed.png'), label: `RECON closed (fid ${(r.fidelity*100).toFixed(0)}%)` },
  { path: path.join(runDir, 'final', 'shot_threeq_open.png'), label: 'RECON open' },
], path.join(ROOT, 'runs/_build.png'), 480);
log(`fidelity=${(r.fidelity*100).toFixed(0)}% cost=$${r.cost.toFixed(3)} -> runs/_build.png`);
