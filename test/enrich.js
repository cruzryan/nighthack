// Flagship behaviors: (1) enrich with a new angle, (2) obey a distance/scale
// command, (3) add interior contents from an "inside" photo and reveal on open.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, MODEL, log } from '../src/config.js';
import { reconstruct, refineScene, loadImageInputs } from '../src/pipeline.js';
import { renderStates, launchBrowser } from '../src/render.js';
import { countBodies, forEachBody, worldAABB } from '../src/scene.js';

const A = f => path.join(ROOT, 'assets', f);
const model = process.env.MODEL || 'gpt-4o-mini';

function widthOf(spec) { const bb = worldAABB(spec); return (bb.hi[0] - bb.lo[0]); }
function hiddenCount(spec) { let n = 0; forEachBody(spec, b => { if (b.hidden_until_open) n++; }); return n; }

(async () => {
  const browser = await launchBrowser();
  const dir = path.join(ROOT, 'runs', 'enrich');
  fs.mkdirSync(dir, { recursive: true });
  log(`model=${model}`);

  const base = await loadImageInputs([A('dresser_34.png')]);
  let r = await reconstruct({ images: base, prompt: 'modern pine dresser, 4 drawers, dark legs', runDir: dir, model, maxIters: 3, browser, onProgress: () => {} });
  let spec = r.spec;
  log(`0) built: ${countBodies(spec).bodies} parts, width=${widthOf(spec).toFixed(2)}m, contents=${hiddenCount(spec)}`);

  // 1) enrich with a NEW ANGLE
  const front = await loadImageInputs([A('dresser_front.png')]);
  r = await refineScene({ spec, userMessage: 'This is the FRONT view of the same dresser. Use it to correct the number of drawers, proportions and the front layout.', images: front, runDir: dir, model, browser, autoCritique: false });
  spec = r.spec;
  log(`1) after front-angle enrich: ${countBodies(spec).bodies} parts, ${countBodies(spec).articulated} joints, width=${widthOf(spec).toFixed(2)}m`);

  // 2) DISTANCE/SCALE command
  r = await refineScene({ spec, userMessage: 'Make the whole dresser exactly 1.5 meters wide (keep proportions).', images: [], runDir: dir, model, browser, autoCritique: false });
  spec = r.spec;
  log(`2) after "1.5m wide": width=${widthOf(spec).toFixed(2)}m  (target 1.5)`);

  // 3) INTERIOR photo -> contents revealed on open
  const inside = await loadImageInputs([A('drawer_interior.png')]);
  r = await refineScene({ spec, userMessage: 'This photo shows the INSIDE of the TOP drawer. Add the visible items as contents INSIDE the top drawer (hidden_until_open=true) so they appear when it is pulled open.', images: inside, runDir: dir, model, browser, autoCritique: false });
  spec = r.spec;
  log(`3) after interior: contents(hidden_until_open)=${hiddenCount(spec)}, parts=${countBodies(spec).bodies}`);

  await renderStates(spec, path.join(dir, 'final'), [
    { name: 'closed', view: 'ref', close: true },
    { name: 'open', view: '34', open: true },
  ], { browser });
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(spec, null, 2));
  log('renders: runs/enrich/final/shot_closed.png, shot_open.png');
  await browser.close();
  process.exit(0);
})().catch(e => { log('ENRICH FAIL: ' + e.message); console.error(e); process.exit(1); });
