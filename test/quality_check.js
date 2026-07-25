import path from 'node:path';
import { ROOT, log } from '../src/config.js';
import { reconstruct, loadImageInputs } from '../src/pipeline.js';
import { launchBrowser } from '../src/render.js';

(async () => {
  const b = await launchBrowser();
  const imgs = await loadImageInputs([path.join(ROOT, 'assets/dresser_34.png')]);
  try {
    const r = await reconstruct({ images: imgs, prompt: 'modern pine dresser, 4 drawers, dark legs', runDir: path.join(ROOT, 'runs/quality_check'), model: 'gpt-4.1', maxIters: 2, browser: b, onProgress: p => log('  · ' + p.msg) });
    log(`QUALITY(gpt-4.1) OK: score=${(r.score * 100).toFixed(0)}%  cost=$${r.cost.toFixed(3)}`);
  } catch (e) { log('QUALITY FAIL: ' + String(e.message || e).slice(0, 200)); }
  await b.close();
  process.exit(0);
})();
