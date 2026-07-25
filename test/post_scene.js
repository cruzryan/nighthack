import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
const dataUri = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets/cand1.png')).toString('base64');
const t0 = Date.now();
const res = await fetch('http://localhost:5188/api/reconstruct', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ images: [dataUri], prompt: 'still-life table', mode: 'scene', model: 'fast' }),
});
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n'); buf = lines.pop();
  for (const ln of lines) if (ln.trim()) { const ev = JSON.parse(ln); console.log(`[${((Date.now()-t0)/1000).toFixed(0)}s]`, ev.phase, ev.msg || (ev.sessionId? 'session '+ev.sessionId+' bodies='+ev.bodies : '')); }
}
console.log('total', ((Date.now()-t0)/1000).toFixed(0)+'s');
