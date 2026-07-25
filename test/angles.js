import path from 'node:path'; import fs from 'node:fs';
import { ROOT } from '../src/config.js';
import { renderStates, launchBrowser } from '../src/render.js';
import { montage } from '../src/imageutil.js';
const spec = JSON.parse(fs.readFileSync(path.join(ROOT,'runs/build_mrz7l3ot/scene.json'),'utf8'));
const b = await launchBrowser();
const s = await renderStates(spec, path.join(ROOT,'runs/_ang'), [
  {name:'front',view:'front',close:true},{name:'left',view:'left',close:true},{name:'right',view:'right',close:true}
], {browser:b});
await b.close();
await montage([
  {path:path.join(ROOT,'assets/dresser_34.png'),label:'SOURCE'},
  {path:s[0].path,label:'FRONT'},{path:s[1].path,label:'LEFT'},{path:s[2].path,label:'RIGHT'}
], path.join(ROOT,'runs/_angles.png'), 420);
console.log('wrote runs/_angles.png');
