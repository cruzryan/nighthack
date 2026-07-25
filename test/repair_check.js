import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { repairDrawers } from '../src/scene.js';
import { renderStates, launchBrowser } from '../src/render.js';

const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'runs/sess_48cde0bf/scene.json'), 'utf8'));
repairDrawers(spec);
// show repaired drawer geometry
for (const b of spec.bodies[0].children.filter(c => c.joint && c.joint.type === 'prismatic'))
  console.log(`  ${b.id}: size=[${b.geometry.size.map(x=>x.toFixed(2))}] pos=[${b.position.map(x=>x.toFixed(2))}] range=[${b.joint.range}]`);
const b = await launchBrowser();
await renderStates(spec, path.join(ROOT, 'runs/repair_check'), [
  { name: 'closed', view: 'ref', close: true },
  { name: 'open', view: 'ref', open: true },
], { browser: b });
await b.close();
console.log('rendered runs/repair_check/shot_closed.png + shot_open.png');
