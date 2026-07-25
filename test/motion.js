import path from 'node:path';
import { ROOT } from '../src/config.js';
import { normalizeScene } from '../src/scene.js';
import { renderStates, launchBrowser } from '../src/render.js';
import { montage } from '../src/imageutil.js';
const spec = normalizeScene({
  meta: { name: 'mini factory' },
  camera: { azimuth_deg: 35, elevation_deg: 22, fov_deg: 45 },
  bodies: [
    { id: 'belt', geometry: { type: 'box', size: [0.4, 0.06, 1.6] }, material: { color: '#2b2b2b', kind: 'metal' }, position: [0, 0.5, 0],
      motion: { type: 'conveyor', axis: [0, 0, 1], rate: 0.5 },
      children: [
        { id: 'box1', geometry: { type: 'box', size: [0.14, 0.14, 0.14] }, material: { color: '#b5651d', kind: 'wood' }, position: [0, 0.1, -0.6] },
        { id: 'box2', geometry: { type: 'box', size: [0.14, 0.14, 0.14] }, material: { color: '#c0392b', kind: 'plastic' }, position: [0, 0.1, -0.1] },
        { id: 'box3', geometry: { type: 'box', size: [0.14, 0.14, 0.14] }, material: { color: '#2e7d5b', kind: 'plastic' }, position: [0, 0.1, 0.4] },
      ] },
    { id: 'leg1', geometry: { type: 'cylinder', radius: 0.03, height: 0.47 }, material: { color: '#555', kind: 'metal' }, position: [0.16, 0.235, -0.7] },
    { id: 'leg2', geometry: { type: 'cylinder', radius: 0.03, height: 0.47 }, material: { color: '#555', kind: 'metal' }, position: [-0.16, 0.235, -0.7] },
    { id: 'leg3', geometry: { type: 'cylinder', radius: 0.03, height: 0.47 }, material: { color: '#555', kind: 'metal' }, position: [0.16, 0.235, 0.7] },
    { id: 'leg4', geometry: { type: 'cylinder', radius: 0.03, height: 0.47 }, material: { color: '#555', kind: 'metal' }, position: [-0.16, 0.235, 0.7] },
    { id: 'roller', geometry: { type: 'cylinder', radius: 0.09, height: 0.44 }, material: { color: '#999', kind: 'metal' }, position: [0, 0.5, 0.82], rotation_deg: [0, 0, 90], motion: { type: 'spin', axis: [0, 1, 0], rate: 4 } },
    { id: 'arm_base', geometry: { type: 'cylinder', radius: 0.05, height: 0.35 }, material: { color: '#c0392b', kind: 'metal' }, position: [0.5, 0.68, 0], motion: { type: 'oscillate', axis: [0, 1, 0], range: 55, period: 2 },
      children: [{ id: 'arm', geometry: { type: 'box', size: [0.34, 0.05, 0.05] }, material: { color: '#e67e22', kind: 'metal' }, position: [0.17, 0.17, 0] }] },
  ],
});
const b = await launchBrowser();
const s = await renderStates(spec, path.join(ROOT, 'runs/_motion'), [
  { name: 't0', view: 'ref', time: 0 }, { name: 't1', view: 'ref', time: 0.8 }, { name: 't2', view: 'ref', time: 1.6 },
], { browser: b });
await b.close();
await montage([{ path: s[0].path, label: 't=0.0s' }, { path: s[1].path, label: 't=0.8s' }, { path: s[2].path, label: 't=1.6s' }], path.join(ROOT, 'runs/_motion.png'), 460);
console.log('wrote runs/_motion.png');
