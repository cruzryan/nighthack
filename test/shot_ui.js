import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../src/config.js';
const b = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1360, height: 860 } });
await p.goto('http://localhost:5188', { waitUntil: 'load' });
await p.waitForTimeout(800);
// load the most recent scene (first recent chip)
const chips = await p.$$('#recent button');
if (chips.length) { await chips[0].click(); await p.waitForFunction(() => document.querySelector('#sParts').textContent !== '0', null, {timeout:15000}); await p.waitForTimeout(2500); }
await p.screenshot({ path: path.join(ROOT, 'runs/ui_final_scene.png'), animations: 'disabled', timeout: 8000 }).catch(()=>{});
console.log('recent chips:', chips.length, '-> screenshot runs/ui_final_scene.png');
await b.close();
