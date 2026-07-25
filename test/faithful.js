import fs from 'node:fs'; import path from 'node:path';
import { ROOT } from '../src/config.js';
import { renderStates, launchBrowser } from '../src/render.js';
import { montage } from '../src/imageutil.js';
// render the ACTUAL saved scene.json, NO repairDrawers cleanup (= what the UI shows)
const spec = JSON.parse(fs.readFileSync(path.join(ROOT,'runs/sess_c5e0f098/scene.json'),'utf8'));
const b = await launchBrowser();
const s = await renderStates(spec, path.join(ROOT,'runs/_faith'), [
  {name:'ref',view:'ref',close:true},{name:'back',view:'back',close:true},{name:'open',view:'iso',open:true}
], {browser:b});
await b.close();
await montage([
  {path:path.join(ROOT,'assets/dresser_34.png'),label:'SOURCE'},
  {path:s[0].path,label:'AS-VIEWER front'},{path:s[1].path,label:'AS-VIEWER back'},{path:s[2].path,label:'AS-VIEWER open'}
], path.join(ROOT,'runs/_faithful.png'), 420);
console.log('wrote runs/_faithful.png');
