import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await p.goto('http://localhost:5188', { waitUntil: 'load' }); await p.waitForTimeout(700);
const modes = await p.$$eval('.modeBtn', els => els.map(e=>e.textContent.trim()));
console.log('modes:', JSON.stringify(modes), '| JS errors:', errs.length?errs.join('|'):'NONE');
await b.close();
