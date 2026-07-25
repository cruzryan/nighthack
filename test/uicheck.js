import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGE: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('CON: ' + m.text()); });
await p.goto('http://localhost:5188', { waitUntil: 'load' });
await p.waitForTimeout(600);
// click scene mode + check state
await p.click('.modeBtn[data-mode="scene"]');
const mode = await p.evaluate(() => window.state?.mode);
const modeGlobal = await p.evaluate(() => typeof state !== 'undefined' ? state.mode : 'NO state global');
console.log('mode after click:', modeGlobal);
console.log('errors:', errs.length ? errs.join(' | ') : 'NONE');
await b.close();
