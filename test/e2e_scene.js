import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, log } from '../src/config.js';
const b = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1300, height: 850 } });
const errs = []; p.on('pageerror', e => errs.push('PAGE:'+e.message)); p.on('console', m => { if (m.type()==='error') errs.push('CON:'+m.text()); });
await p.goto('http://localhost:5188', { waitUntil: 'load' });
await p.click('.modeBtn[data-mode="scene"]');
await p.setInputFiles('#file', path.join(ROOT, 'assets/cand1.png'));
await p.fill('#prompt', 'still-life table');
await p.waitForSelector('#go:not([disabled])');
log('clicking build (scene)…');
await p.click('#go');
try {
  await p.waitForFunction(() => document.querySelector('#sParts').textContent !== '0', null, { timeout: 90000 });
  log('sParts populated: ' + await p.$eval('#sParts', e=>e.textContent));
} catch (e) {
  const logHtml = await p.$eval('#log', e => e.innerText).catch(()=>'(no log)');
  log('TIMEOUT. #log contents:\n' + logHtml);
  log('sParts=' + await p.$eval('#sParts', e=>e.textContent));
}
await p.waitForTimeout(1500);
await p.screenshot({ path: path.join(ROOT, 'runs/ui_scene.png'), animations: 'disabled', timeout: 8000 }).catch(()=>log('screenshot skipped'));
log(errs.length ? ('ERRORS: ' + errs.slice(0,6).join(' | ')) : 'no JS errors');
await b.close();
