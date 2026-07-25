import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1200, height: 820 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  await p.goto('http://localhost:5188', { waitUntil: 'load' });
  await p.waitForTimeout(700);
  const chips = await p.$$eval('#recent button', els => els.map(e => e.textContent.trim()));
  console.log('recent chips:', JSON.stringify(chips));
  if (!chips.length) throw new Error('no recent chips shown');
  await p.click('#recent button');   // load first scene
  await p.waitForFunction(() => document.querySelector('#frame').style.display === 'block' && document.querySelector('#sParts').textContent !== '0', null, { timeout: 20000 });
  await p.waitForTimeout(2000);
  const frame = p.frames().find(f => f.url().includes('/viewer/'));
  const joints = frame ? await frame.evaluate(() => window.__api?.listJoints().length ?? -1) : -2;
  const stats = await p.evaluate(() => ({ name: document.querySelector('#sName').textContent, parts: document.querySelector('#sParts').textContent, joints: document.querySelector('#sJoints').textContent }));
  console.log('after click -> stats:', JSON.stringify(stats), 'viewer joints:', joints);
  // refine box should now be active (refine mode)
  const goText = await p.$eval('#go', e => e.textContent);
  console.log('go button:', goText, '| JS errors:', errs.length ? errs.join('|') : 'NONE');
  await p.screenshot({ path: 'runs/ui_recent.png' });
  await b.close();
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.log('FAIL:', e.message); process.exit(1); });
