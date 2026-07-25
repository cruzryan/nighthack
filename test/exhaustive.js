import path from 'node:path';
import { ROOT, log } from '../src/config.js';
import { reconstructScene } from '../src/multiscene.js';
import { loadImageInputs } from '../src/pipeline.js';
import { launchBrowser } from '../src/render.js';
import { montage } from '../src/imageutil.js';
import { countBodies } from '../src/scene.js';
const model = process.env.MODEL || 'gpt-4o-mini';
const img = process.argv[2] || 'assets/factory_line.png';
const b = await launchBrowser();
const imgs = await loadImageInputs([path.join(ROOT, img)]);
const runDir = path.join(ROOT, 'runs', 'exh_' + Date.now().toString(36));
log('model=' + model + ' img=' + img);
const r = await reconstructScene({ images: imgs, prompt: 'factory production line', runDir, model, browser: b, maxComplete: 4, onProgress: p => { if (/census|found|Pass|added|Scene/.test(p.msg)) log('  · ' + p.msg); } });
await b.close();
await montage([
  { path: path.join(ROOT, img), label: 'SOURCE' },
  { path: path.join(runDir, 'final', 'shot_ref_closed.png'), label: `RECON (${r.objects} objects, ${countBodies(r.spec).bodies} parts)` },
  { path: path.join(runDir, 'final', 'shot_front_closed.png'), label: 'front' },
], path.join(ROOT, 'runs/_exhaustive.png'), 460);
log(`objects=${r.objects} parts=${countBodies(r.spec).bodies} -> runs/_exhaustive.png`);
