import fs from 'node:fs'; import { toMJCF } from '../src/mjcf.js';
const spec = JSON.parse(fs.readFileSync('runs/sess_minifac01/scene.json','utf8'));
const xml = toMJCF(spec); fs.writeFileSync('runs/minifac.xml', xml);
console.log('velocity actuators:', (xml.match(/<velocity/g)||[]).length, '| motion joints:', (xml.match(/_mj"/g)||[]).length);
