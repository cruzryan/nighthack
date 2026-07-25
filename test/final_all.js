import { chromium } from 'playwright';
const GL=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
const b = await chromium.launch({ headless: true, args: GL });
const errs=[];
// app page
const p = await b.newPage({viewport:{width:1200,height:800}});
p.on('pageerror',e=>errs.push('app:'+e.message)); p.on('console',m=>{if(m.type()==='error')errs.push('app:'+m.text());});
await p.goto('http://localhost:5188',{waitUntil:'load'}); await p.waitForTimeout(700);
const modes = await p.$$eval('.modeBtn',e=>e.length);
const recent = await p.$$eval('#recent button',e=>e.length);
const qDefault = await p.$eval('#quality',e=>e.value);
// dresser viewer + inspector + parts (check wood material kinds present)
const sess = await (await fetch('http://localhost:5188/api/sessions')).json();
const dresser = sess.find(s=>(s.name||'').includes('dresser'))||sess[0];
const v = await b.newPage({viewport:{width:900,height:700}});
v.on('pageerror',e=>errs.push('viewer:'+e.message)); v.on('console',m=>{if(m.type()==='error')errs.push('viewer:'+m.text());});
await v.goto('http://localhost:5188/viewer/'+dresser.sessionId,{waitUntil:'load'});
await v.waitForFunction('window.__api&&window.__api.ready===true',{timeout:15000});
const parts = await v.evaluate(()=>window.__api.listParts().length);
const insp = await v.$('#insp-toggle')!==null;
await b.close();
console.log('modes='+modes+' recent='+recent+' qualityDefault='+qDefault+' dresserParts='+parts+' inspector='+insp);
console.log('JS ERRORS: '+(errs.length?errs.slice(0,5).join(' | '):'NONE ✅'));
