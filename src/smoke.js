// Token-free smoke test of the render half: example scene -> HTML -> screenshots,
// then verify (via sharp) that the images actually contain a rendered 3D object
// (non-trivial pixel variance), i.e. headless WebGL works.
import path from 'node:path';
import sharp from 'sharp';
import { RUNS, log } from './config.js';
import { exampleScene, countBodies } from './scene.js';
import { renderStates, standardStates } from './render.js';

async function variance(file) {
  const st = await sharp(file).stats();
  const stdev = st.channels.slice(0, 3).reduce((a, c) => a + c.stdev, 0) / 3;
  const mean = st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3;
  return { mean, stdev };
}

(async () => {
  const spec = exampleScene();
  const c = countBodies(spec);
  log(`example scene: ${c.bodies} bodies, ${c.articulated} articulated joints`);
  const dir = path.join(RUNS, '_smoke');
  log('rendering states (headless WebGL via swiftshader)...');
  const t0 = Date.now();
  const shots = await renderStates(spec, dir, standardStates(), { width: 900, height: 860 });
  log(`rendered ${shots.length} shots in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  let ok = true;
  for (const s of shots) {
    const v = await variance(s.path);
    const pass = v.stdev > 8; // a blank canvas has ~0 stdev
    if (!pass) ok = false;
    log(`  ${s.name.padEnd(14)} mean=${v.mean.toFixed(1)} stdev=${v.stdev.toFixed(1)} ${pass ? 'OK' : 'BLANK!'}`);
  }
  log(shots.length ? `viewer: ${path.join(dir, 'index.html')}` : 'no shots');
  log(ok ? 'SMOKE PASS ✅  (rendering half works)' : 'SMOKE FAIL ❌  (blank renders — WebGL issue)');
  process.exit(ok ? 0 : 1);
})();
