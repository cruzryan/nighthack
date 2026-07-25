import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../src/config.js';
const GL=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
const b = await chromium.launch({ headless: true, args: GL });
const p = await b.newPage({viewport:{width:1340,height:850}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://localhost:5188',{waitUntil:'load'}); await p.waitForTimeout(700);
const recent = await p.$$eval('#recent button', e=>e.map(x=>x.textContent.trim()));
// load the synthetic conveyor demo (cleanest motion) — find chip containing 'conveyor'
const chips = await p.$$('#recent button');
let target=chips[0]; for(const c of chips){ const t=await c.textContent(); if(/conveyor|bottling/i.test(t)){target=c;break;} }
await target.click();
await p.waitForFunction(()=>document.querySelector('#sParts').textContent!=='0',null,{timeout:15000});
await p.waitForTimeout(2500); // let motion run
const frame = p.frames().find(f=>f.url().includes('/viewer/'));
const motion = frame? await frame.evaluate(()=>window.__api.hasMotion()) : false;
await p.screenshot({path:path.join(ROOT,'runs/ui_factory.png'),animations:'disabled',timeout:8000}).catch(()=>{});
console.log('recent='+JSON.stringify(recent.map(r=>r.slice(0,22))));
console.log('loaded motion='+motion+' | JS errors: '+(errs.length?errs.slice(0,4).join('|'):'NONE ✅'));
await b.close();
