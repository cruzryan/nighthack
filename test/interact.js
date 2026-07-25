import { chromium } from 'playwright';
const GL = ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
(async () => {
  const b = await chromium.launch({ headless: true, args: GL });

  // 1) CLICK-TO-OPEN in the viewer
  const vp = await b.newPage({ viewport: { width: 900, height: 800 } });
  await vp.goto('http://localhost:5188/viewer/48cde0bf', { waitUntil: 'load' });
  await vp.waitForFunction('window.__api && window.__api.ready===true', { timeout: 15000 });
  const before = await vp.evaluate(() => window.__api.listJoints().map(j => j.value));
  const canvas = await vp.$('canvas');
  const box = await canvas.boundingBox();
  // click a few points down the vertical center (drawers stack vertically)
  for (const fy of [0.42, 0.52, 0.62, 0.72]) await vp.mouse.click(box.x + box.width * 0.47, box.y + box.height * fy);
  await vp.waitForTimeout(900);
  const after = await vp.evaluate(() => window.__api.listJoints().map(j => j.value));
  const opened = after.filter((v, i) => v > (before[i] + 0.01)).length;
  console.log('click-to-open: before=' + JSON.stringify(before.map(x=>+x.toFixed(2))) + ' after=' + JSON.stringify(after.map(x=>+x.toFixed(2))) + ' -> ' + opened + ' drawer(s) opened by clicking');

  // 2) SOURCE PHOTO overlay in the app
  const ap = await b.newPage({ viewport: { width: 1200, height: 820 } });
  const errs = []; ap.on('pageerror', e => errs.push(e.message));
  await ap.goto('http://localhost:5188', { waitUntil: 'load' });
  await ap.waitForTimeout(700);
  await ap.click('#recent button');
  await ap.waitForFunction(() => document.querySelector('#sParts').textContent !== '0', null, { timeout: 15000 });
  await ap.waitForTimeout(1500);
  const photo = await ap.evaluate(() => { const i = document.querySelector('#refimg'); return { shown: document.querySelector('#refbox').style.display, loaded: i && i.naturalWidth > 0, w: i && i.naturalWidth }; });
  console.log('source-photo overlay:', JSON.stringify(photo), 'JS errors:', errs.length ? errs.join('|') : 'none');
  await ap.screenshot({ path: 'runs/ui_photo.png' });
  await b.close();
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
