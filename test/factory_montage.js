import path from 'node:path'; import fs from 'node:fs';
import { ROOT } from '../src/config.js';
import { renderStates, launchBrowser } from '../src/render.js';
import { montage } from '../src/imageutil.js';
const spec = JSON.parse(fs.readFileSync(path.join(ROOT,'runs/sess_94c33e64/scene.json'),'utf8'));
const b = await launchBrowser();
const s = await renderStates(spec, path.join(ROOT,'runs/_facmv'), [
  {name:'t0',view:'iso',time:0},{name:'t1',view:'iso',time:1.2},{name:'t2',view:'iso',time:2.4}
], {browser:b});
await b.close();
await montage([
  {path:path.join(ROOT,'assets/factory_line.png'),label:'SOURCE'},
  {path:s[0].path,label:'t=0'},{path:s[1].path,label:'t=1.2s'},{path:s[2].path,label:'t=2.4s'}
], path.join(ROOT,'runs/_factory.png'), 420);
console.log('wrote runs/_factory.png');
