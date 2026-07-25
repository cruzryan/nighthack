// img2env frontend: image intake, streaming build/refine, live viewer.
const $ = s => document.querySelector(s);
const state = { sessionId: null, images: [], pending: [], busy: false };

// ---------- image intake ----------
const drop = $('#drop'), fileIn = $('#file'), thumbs = $('#thumbs');
drop.onclick = () => fileIn.click();
fileIn.onchange = e => { for (const f of e.target.files) addFile(f); fileIn.value = ''; };
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) addFile(f); });
window.addEventListener('paste', e => { for (const it of e.clipboardData.files) if (it.type.startsWith('image/')) addFile(it); });

function addFile(f) {
  const r = new FileReader();
  r.onload = () => { const uri = r.result; const item = { uri, isNew: !!state.sessionId }; state.images.push(item); if (item.isNew) state.pending.push(uri); renderThumbs(); updateGo(); };
  r.readAsDataURL(f);
}
function renderThumbs() {
  thumbs.innerHTML = '';
  state.images.forEach((im, i) => {
    const d = document.createElement('div'); d.className = 'thumb' + (im.isNew ? ' new' : '');
    d.innerHTML = `<img src="${im.uri}"/><div class="x">×</div>`;
    d.querySelector('.x').onclick = () => { state.images.splice(i, 1); state.pending = state.pending.filter(p => p !== im.uri); renderThumbs(); updateGo(); };
    thumbs.appendChild(d);
  });
}

// ---------- controls ----------
state.mode = 'object';
document.querySelectorAll('.modeBtn').forEach(btn => btn.onclick = () => {
  if (state.busy) return;
  document.querySelectorAll('.modeBtn').forEach(b => b.classList.remove('on'));
  btn.classList.add('on'); state.mode = btn.dataset.mode;
  $('#drop').querySelector('.sub') && ($('#drop').querySelector('.sub').textContent =
    state.mode === 'scene' ? 'a photo of a table/desk with several objects' : 'front / angles / inside a drawer — more views = better');
});
const iters = $('#iters');
function paintRange(el) {
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty('--fill', pct + '%');
}
iters.oninput = e => { $('#itersV').textContent = e.target.value; paintRange(e.target); };
paintRange(iters);
function updateGo() {
  const go = $('#go');
  if (state.busy) { go.disabled = true; return; }
  if (!state.sessionId) {
    // reconstruction is driven by the photo — a description alone can't build
    const noImg = state.images.length === 0;
    go.disabled = noImg;
    go.textContent = noImg ? 'Add a photo to build' : 'Build environment';
  }
  else { const hasMsg = $('#prompt').value.trim() || state.pending.length; go.disabled = !hasMsg; go.textContent = state.pending.length ? `Enrich (+${state.pending.length} image)` : 'Send refinement'; }
}
$('#prompt').oninput = updateGo;

// ---------- logging ----------
const logEl = $('#log');
function addMsg(cls, html) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html; logEl.appendChild(d); d.scrollIntoView({ block: 'end' }); return d; }
function veil(on, msg) { $('#veil').classList.toggle('on', on); if (msg) $('#veilMsg').textContent = msg; if (!on) bar(0, 0); }
function bar(done, total) {
  const b = $('#veilBar'), f = $('#veilBarFill'), c = $('#veilCount');
  if (!total) { b.classList.remove('on'); c.textContent = ''; return; }
  b.classList.add('on');
  f.style.width = Math.min(100, Math.round(done / total * 100)) + '%';
  c.textContent = done + ' / ' + total + ' objects';
}

// ---------- build / refine ----------
$('#go').onclick = () => state.sessionId ? refine() : build();

async function build() {
  const prompt = $('#prompt').value.trim();
  setBusy(true);
  addMsg('you', prompt ? esc(prompt) : `<i>${state.images.length} image(s)</i>`);
  const act = addMsg('sys act', '<span class="spin"></span>Starting…');
  try {
    await stream('/api/reconstruct', {
      images: state.images.map(i => i.uri), prompt,
      model: $('#quality').value, maxIters: +$('#iters').value, mode: state.mode,
    }, act);
  } catch (e) { act.className = 'msg err'; act.textContent = 'Failed: ' + e.message; }
  setBusy(false);
}

async function refine() {
  const msg = $('#prompt').value.trim();
  setBusy(true);
  addMsg('you', (msg ? esc(msg) : '') + (state.pending.length ? ` <i>(+${state.pending.length} image)</i>` : ''));
  const act = addMsg('sys act', '<span class="spin"></span>Applying…');
  try {
    await stream('/api/refine', { sessionId: state.sessionId, message: msg, images: state.pending.slice() }, act);
    $('#prompt').value = '';
  } catch (e) { act.className = 'msg err'; act.textContent = 'Failed: ' + e.message; }
  setBusy(false);
}

async function stream(url, body, actEl) {
  veil(true, 'Working…');
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) { if (ln.trim()) handleEvent(JSON.parse(ln), actEl); }
  }
  veil(false);
}

function handleEvent(ev, actEl) {
  if (ev.phase === 'error') { actEl.className = 'msg err'; actEl.textContent = '⚠ ' + ev.msg; return; }
  if (ev.msg) { actEl.innerHTML = '<span class="spin"></span>' + esc(ev.msg); veil(true, ev.msg); }
  if (ev.phase === 'scored') {
    const n = ev.round ?? ev.iter, f = ev.fidelity ?? ev.score;
    addMsg('sys', `Round ${n}: <span class="sc">${Math.round((f || 0) * 100)}%</span> fidelity` + (ev.msg && ev.msg.includes('—') ? ' · ' + esc(ev.msg.split('—')[1].trim()) : ''));
  }
  if (ev.phase === 'detected') { addMsg('sys', `Found <b>${ev.total || (ev.objects || []).length}</b> objects — building in parallel…`); bar(0, ev.total || (ev.objects || []).length); }
  if (ev.phase === 'object' && ev.total) bar(ev.done, ev.total);   // live progress, no log spam
  if (ev.phase === 'result') {
    bar(0, 0);
    actEl.className = 'msg sys';
    actEl.innerHTML = `Done — <span class="sc">${ev.score != null ? Math.round(ev.score * 100) + '%' : '✓'}</span> · ${ev.bodies} parts, ${ev.joints} movable`;
    applyResult(ev);
  }
}

function applyResult(r) {
  state.sessionId = r.sessionId; state.pending = [];
  state.images.forEach(i => i.isNew = false); renderThumbs();
  $('#empty').style.display = 'none';
  const f = $('#frame'); f.style.display = 'block'; f.src = r.viewerUrl + (r.viewerUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
  $('#bar').classList.remove('empty');
  $('#sName').textContent = r.name || 'scene';
  $('#sParts').textContent = r.bodies;
  $('#sJoints').textContent = r.joints;
  $('#sScore').textContent = r.score != null ? Math.round(r.score * 100) + '%' : '—';
  $('#sCost').textContent = '$' + (r.cost || 0).toFixed(3);
  ['#bOpen', '#bClose', '#bJson', '#bMjcf', '#bTab', '#bPhoto'].forEach(s => $(s).disabled = false);
  // source photo overlay (compare render vs original)
  state.inputs = r.inputs || r.images || 0;
  const hasPhoto = state.inputs > 0;
  closeLightbox();
  $('#bPhoto').disabled = !hasPhoto;
  if (hasPhoto) { $('#refimg').src = inputUrl(0); $('#refbox').style.display = 'block'; }
  else $('#refbox').style.display = 'none';
  // switch left panel into "refine" mode
  $('#firstHint').style.display = 'none'; $('#opts').style.display = 'none';
  document.querySelector('.lede').style.display = 'none';
  $('#promptLabel').textContent = 'Refine (chat) — or drop a new angle above';
  $('#prompt').placeholder = 'e.g. make the wood darker · the top drawer should open further · everything is 1 m from the camera';
  updateGo();
}

function setBusy(b) { state.busy = b; updateGo(); document.querySelectorAll('select,#iters').forEach(e => e.disabled = b); }

// ---------- viewer controls ----------
const api = () => { try { return $('#frame').contentWindow.__api; } catch { return null; } };
$('#bOpen').onclick = () => api()?.openAll();
$('#bClose').onclick = () => api()?.closeAll();
$('#bPhoto').onclick = () => { const b = $('#refbox'); b.style.display = b.style.display === 'none' ? 'block' : 'none'; };

// ---------- source photo lightbox ----------
const lb = $('#lightbox'), lbStamp = Date.now();
state.inputs = 0; state.shot = 0;
const inputUrl = i => `/api/input/${state.sessionId}/${i}?t=${lbStamp}`;
function showShot(i) {
  const n = Math.max(1, state.inputs);
  state.shot = (i % n + n) % n;
  $('#lbImg').src = inputUrl(state.shot);
  $('#lbCount').textContent = n > 1 ? `${state.shot + 1} / ${n}` : '';
  ['#lbPrev', '#lbNext'].forEach(s => $(s).style.display = n > 1 ? '' : 'none');
}
function openLightbox(i) { if (!state.inputs) return; showShot(i); lb.classList.add('on'); }
function closeLightbox() { lb.classList.remove('on'); }
$('#refbox').onclick = () => openLightbox(0);
$('#lbClose').onclick = closeLightbox;
$('#lbPrev').onclick = () => showShot(state.shot - 1);
$('#lbNext').onclick = () => showShot(state.shot + 1);
lb.onclick = e => { if (e.target === lb) closeLightbox(); };   // click the backdrop to dismiss
window.addEventListener('keydown', e => {
  if (!lb.classList.contains('on')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') showShot(state.shot - 1);
  if (e.key === 'ArrowRight') showShot(state.shot + 1);
});
$('#bTab').onclick = () => window.open($('#frame').src, '_blank');
$('#bJson').onclick = () => dl(`/api/scene/${state.sessionId}`, (state.sessionId || 'scene') + '.json');
$('#bMjcf').onclick = () => dl(`/api/mjcf/${state.sessionId}`, (state.sessionId || 'scene') + '.xml');
function dl(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ---- new scene / reset ----
$('#newScene').onclick = () => {
  if (state.busy) return;
  state.sessionId = null; state.images = []; state.pending = [];
  renderThumbs(); logEl.innerHTML = '';
  $('#prompt').value = ''; $('#frame').style.display = 'none'; $('#frame').src = 'about:blank';
  $('#empty').style.display = 'flex';
  $('#firstHint').style.display = ''; $('#opts').style.display = '';
  document.querySelector('.lede').style.display = '';
  $('#promptLabel').textContent = 'Describe it (optional)';
  $('#prompt').placeholder = 'e.g. a wooden nightstand ~0.5 m wide with 2 drawers and a cabinet door. It sits 1 m from the camera.';
  $('#bar').classList.add('empty');
  $('#sName').textContent = 'No scene loaded';
  $('#sParts').textContent = '0'; $('#sJoints').textContent = '0'; $('#sScore').textContent = '—'; $('#sCost').textContent = '$0';
  ['#bOpen', '#bClose', '#bJson', '#bMjcf', '#bTab', '#bPhoto'].forEach(s => $(s).disabled = true);
  $('#refbox').style.display = 'none'; state.inputs = 0; closeLightbox();
  $('#newScene').style.display = 'none';
  updateGo(); loadRecent();
};

// reveal "New" once a scene exists
const _apply = applyResult;
applyResult = function (r) { _apply(r); $('#newScene').style.display = 'inline-block'; loadRecent(); };

// ---- recent scenes strip ----
async function loadRecent() {
  try {
    const list = await (await fetch('/api/sessions')).json();
    const wrap = $('#recentWrap'), box = $('#recent');
    if (!list.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    box.innerHTML = '';
    for (const s of list) {
      const chip = document.createElement('button');
      if (s.sessionId === state.sessionId) chip.className = 'sel';
      chip.innerHTML = `<span class="nm">${esc(s.name || 'scene')}</span><span class="mt">${s.joints} moving</span>`;
      chip.onclick = () => {
        if (state.busy || s.sessionId === state.sessionId) return;
        // switching scenes: drop images staged for the previous one
        state.images = []; state.pending = []; renderThumbs();
        applyResult(s); addMsg('sys', `Loaded <b>${esc(s.name || 'scene')}</b> — chat to keep refining it.`);
      };
      box.appendChild(chip);
    }
  } catch {}
}
loadRecent();
updateGo();
