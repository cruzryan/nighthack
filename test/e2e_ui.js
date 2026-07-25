// Drive the real UI end-to-end: upload -> build -> verify viewer renders +
// articulation API works -> refine -> verify update. Screenshots each stage.
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, log } from '../src/config.js';

const BASE = 'http://localhost:5188';
const shot = p => path.join(ROOT, 'runs', p);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGE: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  log('open UI'); await page.goto(BASE, { waitUntil: 'load' });
  await page.setInputFiles('#file', path.join(ROOT, 'assets/dresser_34.png'));
  await page.fill('#prompt', '');
  await page.selectOption('#quality', 'quality');
  await page.evaluate(() => { const r = document.querySelector('#iters'); r.value = 3; r.dispatchEvent(new Event('input')); });
  await page.waitForSelector('#go:not([disabled])');
  log('click build (this runs the real loop; ~90s)…');
  const t0 = Date.now();
  await page.click('#go');

  // wait for a result: stats populate + iframe shows
  await page.waitForFunction(() => document.querySelector('#sParts').textContent !== '0' && document.querySelector('#frame').style.display === 'block', null, { timeout: 240000 });
  log(`built in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await page.waitForTimeout(2500); // let viewer paint
  await page.screenshot({ path: shot('ui_built.png') });

  // verify the viewer iframe actually rendered an articulated model
  const frame = page.frames().find(f => f.url().includes('/viewer/'));
  if (!frame) throw new Error('viewer iframe not found');
  const joints = await frame.evaluate(() => window.__api ? window.__api.listJoints().length : -1);
  log(`viewer __api joints = ${joints}`);
  const stats = await page.evaluate(() => ({ parts: $('#sParts')?.textContent, joints: $('#sJoints')?.textContent, score: $('#sScore')?.textContent, cost: $('#sCost')?.textContent }));
  log('stats: ' + JSON.stringify(stats));

  // exercise "Open all" then screenshot the interactive state
  await page.click('#bOpen'); await page.waitForTimeout(1200);
  await page.screenshot({ path: shot('ui_open.png') });

  // refine via chat
  log('refine: "make the wood much darker walnut brown"…');
  await page.fill('#prompt', 'make the wood much darker, a rich walnut brown, and give it clearly visible dark legs');
  await page.waitForSelector('#go:not([disabled])');
  const before = await page.evaluate(() => document.querySelector('#frame').src);
  await page.click('#go');
  await page.waitForFunction(prev => { const f = document.querySelector('#frame'); return f.src !== prev && document.querySelector('#veil').classList.contains('on') === false; }, before, { timeout: 180000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: shot('ui_refined.png') });
  log('refine done');

  log(errors.length ? ('JS ERRORS:\n' + errors.slice(0, 8).join('\n')) : 'no JS errors ✅');
  await browser.close();
  log('screenshots: runs/ui_built.png, ui_open.png, ui_refined.png');
  process.exit(0);
})().catch(e => { log('E2E FAIL: ' + e.message); process.exit(1); });
