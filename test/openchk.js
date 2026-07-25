import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from '../src/config.js';
import { repairDrawers } from '../src/scene.js';
import { renderStates, launchBrowser } from '../src/render.js';
import { montage } from '../src/imageutil.js';
const spec = JSON.parse(fs.readFileSync(path.join(ROOT,'runs/sess_48cde0bf/scene.json'), 'utf8'));
repairDrawers(spec);
const b = await launchBrowser();
const s = await renderStates(spec, path.join(ROOT,'runs/_openchk'), [
  { name: 'closed', view: 'ref', close: true },
  { name: 'open', view: 'ref', open: true },
], { browser: b });
await b.close();
await montage([{path:s[0].path,label:'CLOSED'},{path:s[1].path,label:'OPEN (all drawers)'}], path.join(ROOT,'runs/_openchk.png'), 500);
console.log('wrote runs/_openchk.png');
