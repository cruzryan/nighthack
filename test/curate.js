import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log } from '../src/config.js';
const uri = p => 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, p)).toString('base64');
async function gen(label, body) {
  const t0 = Date.now();
  const res = await fetch('http://localhost:5188/api/reconstruct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', sid = '';
  while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) if (ln.trim()) { const ev = JSON.parse(ln); if (ev.phase === 'result') sid = ev.sessionId; if (ev.phase === 'error') log('  ERR ' + ev.msg); }
  }
  log(`${label}: session ${sid} in ${((Date.now()-t0)/1000).toFixed(0)}s`);
}
// hero single object (quality, generic prompt = no leakage)
await gen('dresser', { images: [uri('assets/dresser_34.png')], prompt: '', mode: 'object', model: 'quality', maxIters: 5 });
// multi-object scene (quality)
await gen('still-life', { images: [uri('assets/cand1.png')], prompt: '', mode: 'scene', model: 'quality' });
