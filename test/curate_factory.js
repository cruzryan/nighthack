import fs from 'node:fs'; import path from 'node:path';
import { ROOT, log } from '../src/config.js';
const uri = p => 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, p)).toString('base64');
const t0 = Date.now();
const res = await fetch('http://localhost:5188/api/reconstruct', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ images: [uri('assets/factory_line.png')], prompt: 'a bottling-plant production line — reconstruct the conveyor and machines and make the moving parts move', mode: 'object', model: 'quality', maxIters: 7 }) });
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', sid = '';
while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n'); buf = lines.pop();
  for (const ln of lines) if (ln.trim()) { const ev = JSON.parse(ln); if (ev.phase === 'result') sid = ev.sessionId; if (ev.msg && /Round|rebuild|Done/.test(ev.msg)) log('  '+ev.msg.slice(0,90)); if (ev.phase==='error') log('  ERR '+ev.msg); } }
log(`factory session ${sid} in ${((Date.now()-t0)/1000).toFixed(0)}s`);
fs.writeFileSync(path.join(ROOT,'runs/_factory_sid.txt'), sid);
