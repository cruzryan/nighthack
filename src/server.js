// Local server: minimal UI + reconstruction API. No login, all in-memory.
// Progress streams back as NDJSON so the UI shows the loop live.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { ROOT, RUNS, log } from './config.js';
import { reconstruct, refineScene, loadImageInputs } from './pipeline.js';
import { reconstructScene } from './multiscene.js';
import { launchBrowser, renderStates, standardStates } from './render.js';
import { countBodies, fitCamera, repairDrawers } from './scene.js';
import { toMJCF } from './mjcf.js';

const PORT = process.env.PORT || 5188;
const MODEL_MAP = { fast: 'gpt-4o-mini', balanced: 'gpt-4.1-mini', quality: 'gpt-4.1' };
const sessions = new Map();
let BROWSER = null;

// keep the render browser alive; relaunch if it ever disconnects/crashes
async function getBrowser() {
  if (!BROWSER || !BROWSER.isConnected()) { log('launching render browser…'); BROWSER = await launchBrowser(); }
  return BROWSER;
}

// rehydrate past sessions from disk so viewers + refine survive a restart.
// Also re-applies the latest deterministic repairs and re-renders the viewer,
// so older scenes get the newest drawer/geometry fixes.
async function rehydrate() {
  let n = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(RUNS).filter(d => d.startsWith('sess_')); } catch {}
  for (const d of dirs) {
    const runDir = path.join(RUNS, d), sceneP = path.join(runDir, 'scene.json');
    if (!fs.existsSync(sceneP)) continue;
    try {
      const spec = JSON.parse(fs.readFileSync(sceneP, 'utf8'));
      repairDrawers(spec);
      sessions.set(d.slice(5), { spec, images: [], runDir, model: 'fast', rev: 2, restored: true });
      try {
        await renderStates(spec, path.join(runDir, 'final'), standardStates(), { browser: BROWSER });
        fs.writeFileSync(sceneP, JSON.stringify(spec, null, 2));
      } catch {}
      n++;
    } catch {}
  }
  if (n) log(`rehydrated + re-rendered ${n} session(s)`);
}

const app = express();
app.use(express.json({ limit: '48mb' }));
app.use(express.static(path.join(ROOT, 'public')));

function saveDataUri(dataUri, dest) {
  const m = /^data:(image\/\w+);base64,(.+)$/s.exec(dataUri);
  if (!m) throw new Error('bad data uri');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(m[2], 'base64'));
  return dest;
}

function ndjson(res) {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  return ev => { try { res.write(JSON.stringify(ev) + '\n'); } catch {} };
}

function inputCount(runDir) {
  try { return fs.readdirSync(path.join(runDir, 'inputs')).filter(f => /^img\d+\.png$/.test(f)).length; } catch { return 0; }
}
function summarize(id) {
  const s = sessions.get(id); if (!s) return null;
  const c = countBodies(s.spec);
  return { sessionId: id, name: s.spec.meta?.name, bodies: c.bodies, joints: c.articulated, score: s.score ?? null, cost: s.cost || 0, inputs: inputCount(s.runDir), viewerUrl: `/viewer/${id}?v=${s.rev}` };
}

app.post('/api/reconstruct', async (req, res) => {
  const emit = ndjson(res);
  try {
    const { images = [], prompt = '', model = 'fast', maxIters = 5, mode = 'object' } = req.body || {};
    if (!images.length) { emit({ phase: 'error', msg: 'no images provided' }); return res.end(); }
    const id = crypto.randomUUID().slice(0, 8);
    const runDir = path.join(RUNS, 'sess_' + id);
    const paths = images.map((d, i) => saveDataUri(d, path.join(runDir, 'inputs', `img${i}.png`)));
    const imgs = await loadImageInputs(paths);
    const mdl = MODEL_MAP[model] || model;
    emit({ phase: 'start', sessionId: id, msg: `Reconstructing from ${imgs.length} image(s)…` });
    let res2;
    if (mode === 'scene') {
      res2 = await reconstructScene({ images: imgs, prompt, runDir, model: mdl, browser: await getBrowser(), onProgress: emit });
    } else {
      res2 = await reconstruct({ images: imgs, prompt, runDir, model: mdl, maxIters: Math.min(8, Math.max(1, maxIters)), browser: await getBrowser(), onProgress: emit });
    }
    sessions.set(id, { spec: res2.spec, images: imgs, runDir, prompt, model, score: res2.score ?? null, cost: res2.cost || 0, history: res2.history || [], rev: 1 });
    emit({ phase: 'result', ...summarize(id) });
    res.end();
  } catch (e) {
    log('reconstruct error', e); emit({ phase: 'error', msg: String(e.message || e) }); res.end();
  }
});

app.post('/api/refine', async (req, res) => {
  const emit = ndjson(res);
  try {
    const { sessionId, message = '', images = [] } = req.body || {};
    const s = sessions.get(sessionId);
    if (!s) { emit({ phase: 'error', msg: 'unknown session' }); return res.end(); }
    let newImgs = [];
    if (images.length) {
      const base = s.images.length;
      const paths = images.map((d, i) => saveDataUri(d, path.join(s.runDir, 'inputs', `img${base + i}.png`)));
      newImgs = await loadImageInputs(paths);
      s.images.push(...newImgs);
    }
    emit({ phase: 'start', sessionId, msg: newImgs.length ? `Enriching with ${newImgs.length} new image(s)…` : 'Applying your change…' });
    const r = await refineScene({
      spec: s.spec, userMessage: message, images: newImgs, runDir: s.runDir,
      model: MODEL_MAP[s.model] || s.model, browser: await getBrowser(), onProgress: emit,
    });
    s.spec = r.spec; s.rev = (s.rev || 1) + 1; if (r.score != null) s.score = r.score; s.cost = (s.cost || 0) + (r.cost || 0);
    s.history = s.history || []; s.history.push({ message, images: newImgs.length, score: r.score });
    emit({ phase: 'result', ...summarize(sessionId) });
    res.end();
  } catch (e) {
    log('refine error', e); emit({ phase: 'error', msg: String(e.message || e) }); res.end();
  }
});

app.get('/viewer/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  const p = s && path.join(s.runDir, 'final', 'index.html');
  if (p && fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send('viewer not ready');
});

// serve an original reference photo so the UI can show source-vs-render
app.get('/api/input/:id/:n', (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).end();
  const p = path.join(s.runDir, 'inputs', `img${req.params.n | 0}.png`);
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).end();
});

app.get('/api/scene/:id', (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'unknown' });
  res.json(s.spec);
});

app.get('/api/mjcf/:id', (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).send('unknown');
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename="${s.spec.meta?.name || 'scene'}.xml"`);
  res.send(toMJCF(s.spec));
});

app.get('/api/state/:id', (req, res) => {
  const sum = summarize(req.params.id); if (!sum) return res.status(404).json({ error: 'unknown' });
  res.json(sum);
});

// list all known scenes (for the UI "Recent scenes" strip), newest first
app.get('/api/sessions', (req, res) => {
  const list = [...sessions.keys()].map(id => {
    const sum = summarize(id); if (!sum) return null;
    let mtime = 0; try { mtime = fs.statSync(path.join(sessions.get(id).runDir, 'scene.json')).mtimeMs; } catch {}
    return { ...sum, mtime };
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  res.json(list);
});

(async () => {
  BROWSER = await launchBrowser();
  app.listen(PORT, () => log(`img2env UI  →  http://localhost:${PORT}`));
  await rehydrate();
})();

process.on('SIGINT', async () => { try { await BROWSER?.close(); } catch {} process.exit(0); });
