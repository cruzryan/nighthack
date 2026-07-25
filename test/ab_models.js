// A/B: which cheap model produces the best first-pass reconstruction?
// perceive -> render ref_closed -> critique, per model. Saves each render.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log } from '../src/config.js';
import { perceive, critique } from '../src/agents.js';
import { renderStates, launchBrowser } from '../src/render.js';
import { loadImageInputs } from '../src/pipeline.js';
import { fileToScaledDataUri } from '../src/imageutil.js';
import { countBodies } from '../src/scene.js';

const PRICES = { 'gpt-4o-mini': [0.15, 0.6], 'gpt-4.1-nano': [0.1, 0.4], 'gpt-4.1-mini': [0.4, 1.6], 'gpt-4.1': [2, 8], 'gpt-5-nano': [0.05, 0.4], 'gpt-5-mini': [0.25, 2], 'gpt-5.1': [1.25, 10] };
const cost = (u, m) => (((u?.prompt_tokens || 0) * (PRICES[m]?.[0] || 0.2) + (u?.completion_tokens || 0) * (PRICES[m]?.[1] || 1)) / 1e6);
const MODELS = process.argv.slice(2);
if (!MODELS.length) MODELS.push('gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-mini');

const prompt = 'modern faceted pine dresser about 0.9m wide and 0.8m tall with 4 sliding drawers each with a dark horizontal bar handle, and 4 dark tapered angled legs';

(async () => {
  const images = await loadImageInputs([path.join(ROOT, 'assets/dresser_34.png')]);
  const dataUris = images.map(i => i.dataUri);
  const browser = await launchBrowser();
  const abDir = path.join(ROOT, 'test/ab'); fs.mkdirSync(abDir, { recursive: true });
  const rows = [];
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const { spec, usage } = await perceive({ images: dataUris, prompt, model });
      let c = cost(usage, model);
      const c2 = countBodies(spec);
      const dir = path.join(abDir, model.replace(/[^a-z0-9]/gi, '_'));
      const shots = await renderStates(spec, dir, [{ name: 'ref', view: 'ref', close: true }, { name: '34open', view: '34', open: true }], { browser });
      const cr = await critique({ realImage: dataUris[0], renderImages: [await fileToScaledDataUri(shots[0].path, 768)], spec, model });
      c += cost(cr.usage, model);
      fs.copyFileSync(shots[0].path, path.join(abDir, `${model.replace(/[^a-z0-9]/gi, '_')}.png`));
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      rows.push({ model, score: cr.score, bodies: c2.bodies, joints: c2.articulated, cost: c, secs });
      log(`${model.padEnd(14)} score=${cr.score.toFixed(2)} bodies=${c2.bodies} joints=${c2.articulated} cost≈$${c.toFixed(4)} ${secs}s`);
    } catch (e) {
      log(`${model.padEnd(14)} ERROR ${String(e.message || e).slice(0, 120)}`);
      rows.push({ model, error: String(e.message || e).slice(0, 120) });
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(abDir, 'results.json'), JSON.stringify(rows, null, 2));
  log('renders + results in test/ab/');
})();
