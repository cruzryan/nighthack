// Verification montage: source photo | closed render | open render (3/4).
// Usage: node test/montage.js <scene.json|sessionDir> <sourceImg> [outName]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { renderStates, launchBrowser } from '../src/render.js';
import { montage } from '../src/imageutil.js';

const arg = process.argv[2], src = process.argv[3], outName = process.argv[4] || '_montage.png';
let sceneP = arg;
if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) sceneP = path.join(arg, 'scene.json');
const spec = JSON.parse(fs.readFileSync(sceneP, 'utf8'));
// render EXACTLY as the viewer shows it (no cleanup) — honest verification
const b = await launchBrowser();
const dir = path.join(ROOT, 'runs', '_mont');
const shots = await renderStates(spec, dir, [
  { name: 'closed', view: 'ref', close: true },
  { name: 'open', view: '34', open: true },
], { browser: b });
await b.close();
const panels = [];
if (src && fs.existsSync(src)) panels.push({ path: src, label: 'SOURCE PHOTO' });
panels.push({ path: shots.find(s => s.name === 'closed').path, label: 'RECONSTRUCTION (closed)' });
panels.push({ path: shots.find(s => s.name === 'open').path, label: 'RECONSTRUCTION (open)' });
await montage(panels, path.join(ROOT, 'runs', outName), 460);
console.log('wrote runs/' + outName);
