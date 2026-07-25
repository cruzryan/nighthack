import path from 'node:path'; import fs from 'node:fs';
import { ROOT, log } from '../src/config.js';
import { reconstructScene } from '../src/multiscene.js';
import { loadImageInputs } from '../src/pipeline.js';
import { launchBrowser } from '../src/render.js';
import { montage } from '../src/imageutil.js';
import { countBodies } from '../src/scene.js';
const model = process.env.MODEL || 'gpt-4.1';
const b = await launchBrowser();
const airImg = await loadImageInputs([path.join(ROOT, 'assets/factory_a321.png')]);
const botImg = await loadImageInputs([path.join(ROOT, 'assets/factory_line.png')]);
const dA = path.join(ROOT, 'runs', 'both_air_' + Date.now().toString(36));
const dB = path.join(ROOT, 'runs', 'both_bot_' + Date.now().toString(36));
log('running BOTH in parallel with model=' + model + ' …');
const t0 = Date.now();
const [air, bot] = await Promise.all([
  reconstructScene({ images: airImg, prompt: 'aircraft final assembly line', runDir: dA, model, browser: b, onProgress: () => {} }),
  reconstructScene({ images: botImg, prompt: 'bottling plant production line', runDir: dB, model, browser: b, onProgress: () => {} }),
]);
await b.close();
log(`done in ${((Date.now()-t0)/1000).toFixed(0)}s — aircraft ${air.objects} obj/${countBodies(air.spec).bodies} parts, bottling ${bot.objects} obj/${countBodies(bot.spec).bodies} parts`);
await montage([
  { path: path.join(ROOT, 'assets/factory_a321.png'), label: 'AIRCRAFT source' },
  { path: path.join(dA, 'final', 'shot_ref_closed.png'), label: `recon (${air.objects} obj)` },
  { path: path.join(ROOT, 'assets/factory_line.png'), label: 'BOTTLING source' },
  { path: path.join(dB, 'final', 'shot_ref_closed.png'), label: `recon (${bot.objects} obj)` },
], path.join(ROOT, 'runs/_both.png'), 380);
// update the seeded examples
fs.copyFileSync(path.join(dA, 'scene.json'), path.join(ROOT, 'examples/sess_abaf695f/scene.json'));
fs.copyFileSync(path.join(dB, 'scene.json'), path.join(ROOT, 'examples/sess_94c33e64/scene.json'));
fs.copyFileSync(path.join(dA, 'scene.json'), path.join(ROOT, 'runs/sess_abaf695f/scene.json'));
fs.copyFileSync(path.join(dB, 'scene.json'), path.join(ROOT, 'runs/sess_94c33e64/scene.json'));
log('updated examples + montage runs/_both.png');
