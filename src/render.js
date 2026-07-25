// Playwright renderer: SceneSpec -> screenshots of deterministic states.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { compileHTML } from './viewer.js';
import { fitCamera } from './scene.js';

const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--disable-dev-shm-usage',
];

export async function launchBrowser() {
  return chromium.launch({ headless: true, args: GL_ARGS });
}

// Write index.html for a spec into dir, return its file:// url + path.
export function writeViewer(spec, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const html = compileHTML(spec);
  const p = path.join(dir, 'index.html');
  fs.writeFileSync(p, html);
  return { path: p, url: 'file://' + p.replace(/\\/g, '/') };
}

// states: array of { name, view?, camera?:[az,el,dist], joints?:{id:val}, fracs?:{id:0..1}, open?:bool }
export async function renderStates(spec, dir, states, opts = {}) {
  const W = opts.width || 960, H = opts.height || 900;
  if (opts.fit !== false) fitCamera(spec); // auto-frame so the object always fills the view
  const { url } = writeViewer(spec, dir);
  const browser = opts.browser || await launchBrowser();
  const ownBrowser = !opts.browser;
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const out = [];
  try {
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__api && window.__api.ready === true', null, { timeout: 20000 });
    if (errs.length) console.warn('  [render] page errors:', errs.slice(0, 3).join(' | '));

    for (const st of states) {
      await page.evaluate((s) => {
        const api = window.__api;
        if (s.plain) { api.setBackground('#ffffff'); api.setGround(false); } else { api.resetEnv(); }
        if (s.view) api.setView(s.view);
        if (s.camera) api.setCamera(s.camera[0], s.camera[1], s.camera[2]);
        if (s.open) api.openAll();
        if (s.close) api.closeAll();
        if (s.joints) for (const k in s.joints) api.setJoint(k, s.joints[k]);
        if (s.fracs) for (const k in s.fracs) api.setFrac(k, s.fracs[k]);
        if (s.time != null && api.setTime) api.setTime(s.time);
        if (s.focus && api.focusAt) api.focusAt(s.focus, s.az, s.el, s.dist);   // zoom onto one object
        api.render();
      }, st);
      await page.waitForTimeout(120); // let shadows/tweens settle
      const file = path.join(dir, `shot_${st.name}.png`);
      await page.screenshot({ path: file });
      out.push({ name: st.name, path: file });
    }
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
  return out;
}

// Convenience: the standard shot set used for critique.
export function standardStates() {
  return [
    { name: 'ref_closed', view: 'ref', close: true },
    { name: 'ref_open', view: 'ref', open: true },
    { name: 'front_closed', view: 'front', close: true },
    { name: 'side_closed', view: 'side', close: true },
    { name: 'threeq_open', view: '34', open: true },
  ];
}
