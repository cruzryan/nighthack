import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGE: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CON: ' + m.text()); });
  await p.goto('http://localhost:5188', { waitUntil: 'load' });
  await p.waitForTimeout(800);
  const hasBtn = await p.$('#newScene') != null;
  const goDisabled = await p.$eval('#go', e => e.disabled);
  // load a rehydrated viewer directly
  const st = await (await fetch('http://localhost:5188/api/state/48cde0bf')).json?.() ?? {};
  console.log('page JS errors:', errs.length ? errs.join(' | ') : 'NONE');
  console.log('newScene btn present:', hasBtn, '| build disabled initially:', goDisabled);
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
