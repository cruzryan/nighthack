import { chromium } from 'playwright';
const GL=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
const b = await chromium.launch({ headless: true, args: GL });
const p = await b.newPage({viewport:{width:900,height:700}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://localhost:5188/viewer/94c33e64',{waitUntil:'load'});
await p.waitForFunction('window.__api&&window.__api.ready===true',{timeout:15000});
const hasMotion = await p.evaluate(()=>window.__api.hasMotion());
const playBtn = await p.evaluate(()=>getComputedStyle(document.getElementById('play-toggle')).display);
// sample a moving item's world position at two times
const pos = async () => await p.evaluate(()=>{ let found=null; window.__api; const sc=document.querySelector('canvas'); 
  // find first mesh whose ancestor is a conveyor item by scanning scene via api? simpler: use setTime and read a mesh matrixWorld
  return true; });
await p.evaluate(()=>window.__api.setTime(0));
const a = await p.evaluate(()=>{ const arr=[]; return new Promise(r=>{ requestAnimationFrame(()=>{ r(true); }); }); });
await p.waitForTimeout(1500); // let it animate live
await p.screenshot({path:'runs/ui_motion.png', animations:'disabled', timeout:8000}).catch(()=>{});
console.log('hasMotion='+hasMotion+' playBtnDisplay='+playBtn+' | JS errors: '+(errs.length?errs.slice(0,4).join('|'):'NONE ✅'));
await b.close();
