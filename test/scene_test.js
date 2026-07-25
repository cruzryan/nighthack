import path from 'node:path';
import { ROOT, log } from '../src/config.js';
import { reconstructScene } from '../src/multiscene.js';
import { loadImageInputs } from '../src/pipeline.js';
import { launchBrowser, renderStates } from '../src/render.js';
import { montage } from '../src/imageutil.js';

const img = process.argv[2] || 'assets/cand1.png';
const model = process.env.MODEL || 'gpt-4o-mini';
const b = await launchBrowser();
const imgs = await loadImageInputs([path.join(ROOT, img)]);
const runDir = path.join(ROOT, 'runs', 'scene_' + Date.now().toString(36));
log('model=' + model + ' img=' + img);
const r = await reconstructScene({ images: imgs, prompt: 'a still-life table with several objects', runDir, model, browser: b, onProgress: p => log('  · ' + p.msg) });
// extra angle
const s2 = await renderStates(r.spec, path.join(runDir, 'v2'), [{ name: 'front', view: 'front', close: true }], { browser: b });
await b.close();
await montage([
  { path: path.join(ROOT, img), label: 'SOURCE SCENE' },
  { path: path.join(runDir, 'final', 'shot_ref_closed.png'), label: 'RECONSTRUCTION 3/4' },
  { path: s2[0].path, label: 'RECONSTRUCTION front' },
], path.join(ROOT, 'runs/_scene.png'), 460);
log('objects=' + r.objects + '  montage=runs/_scene.png');
