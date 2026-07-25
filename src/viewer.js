// Deterministic compiler: SceneSpec -> a single self-contained interactive HTML.
// three.js is inlined so the file works via file:// (Playwright) and as an
// artifact with no network. Exposes window.__api for headless control.
import { THREE_SRC } from './config.js';

const CLIENT_JS = String.raw`
(function () {
  const SPEC = window.__SCENE__;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SPEC.environment.background);

  const W = () => window.innerWidth, H = () => window.innerHeight;
  const camera = new THREE.PerspectiveCamera(SPEC.camera.fov_deg, W() / H(), 0.01, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W(), H());
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // ---- lighting: neutral studio so material colors read true ----
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8892a0, 0.75);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xffffff, 0.35); scene.add(amb);
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(3, 5, 4); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 30;
  key.shadow.camera.left = -6; key.shadow.camera.right = 6;
  key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-4, 3, -2); scene.add(fill);

  // ---- ground ----
  let groundMesh = null;
  {
    const g = SPEC.environment.ground;
    groundMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(g.size, g.size),
      new THREE.MeshStandardMaterial({ color: g.color, roughness: 0.95, metalness: 0.0 })
    );
    groundMesh.rotation.x = -Math.PI / 2; groundMesh.receiveShadow = true; groundMesh.position.y = 0;
    groundMesh.visible = g.visible;
    scene.add(groundMesh);
  }

  const D2R = Math.PI / 180;
  function makeGeometry(g) {
    switch (g.type) {
      case 'box': {
        if (g.bevel && g.bevel > 0.0005) return roundedBox(g.size[0], g.size[1], g.size[2], g.bevel);
        return new THREE.BoxGeometry(g.size[0], g.size[1], g.size[2]);
      }
      case 'plane': return new THREE.BoxGeometry(g.size[0], Math.max(g.size[1], 0.002), g.size[2]);
      case 'sphere': return new THREE.SphereGeometry(g.radius, 32, 24);
      case 'cylinder': return new THREE.CylinderGeometry(g.radius, g.radius, g.height, 40);
      case 'cone': return new THREE.ConeGeometry(g.radius, g.height, 40);
      case 'capsule': return new THREE.CapsuleGeometry(g.radius, Math.max(g.height - 2 * g.radius, 0.01), 8, 20);
      case 'torus': return new THREE.TorusGeometry(g.radius, g.tube, 16, 40);
      case 'lathe': {
        const pts = g.profile.map(p => new THREE.Vector2(Math.max(0.0005, p[0] * g.radius), p[1] * g.height - g.height / 2));
        return new THREE.LatheGeometry(pts, 48);
      }
      case 'extrude': {
        const s = new THREE.Shape(g.shape.map(p => new THREE.Vector2(p[0], p[1])));
        const geo = new THREE.ExtrudeGeometry(s, { depth: g.depth, bevelEnabled: false });
        geo.translate(0, 0, -g.depth / 2); geo.computeVertexNormals();
        return geo;
      }
      default: return new THREE.BoxGeometry(0.1, 0.1, 0.1);
    }
  }
  function roundedBox(w, h, d, r) {
    r = Math.min(r, w / 2, h / 2, d / 2);
    const shape = new THREE.Shape();
    const eps = 0.00001;
    // simple bevel via ExtrudeGeometry on a rounded rectangle cross-section
    const x = -w / 2, y = -h / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r);
    shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: d - 2 * r + eps, bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: 3, steps: 1 });
    geo.translate(0, 0, -(d / 2 - r));
    geo.computeVertexNormals();
    return geo;
  }

  function makeMeshes(g, mat) {
    const B = (sx, sy, sz, px, py, pz) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat); m.position.set(px, py, pz); return m; };
    if (g.type === 'tray') {
      const w = g.size[0], h = g.size[1], d = g.size[2], t = g.wall || 0.02, out = [];
      out.push(B(w, t, d, 0, -h / 2 + t / 2, 0));            // bottom
      out.push(B(w, h, t, 0, 0, -d / 2 + t / 2));            // back
      out.push(B(w, h, t, 0, 0, d / 2 - t / 2));             // front (drawer face)
      out.push(B(t, h, d, -w / 2 + t / 2, 0, 0));            // left
      out.push(B(t, h, d, w / 2 - t / 2, 0, 0));             // right
      return out;                                           // open top
    }
    if (g.type === 'frame') {                                // open-FRONT carcass (cabinet shell)
      const w = g.size[0], h = g.size[1], d = g.size[2], t = g.wall || 0.02, out = [];
      out.push(B(w, t, d, 0, h / 2 - t / 2, 0));             // top
      out.push(B(w, t, d, 0, -h / 2 + t / 2, 0));            // bottom
      out.push(B(w, h, t, 0, 0, -d / 2 + t / 2));            // back
      out.push(B(t, h, d, -w / 2 + t / 2, 0, 0));            // left
      out.push(B(t, h, d, w / 2 - t / 2, 0, 0));             // right
      return out;                                           // open front (drawers show)
    }
    return [new THREE.Mesh(makeGeometry(g), mat)];
  }

  // ---- procedural material textures (grain/mottle) — makes wood look like wood ----
  const _texCache = {};
  function _hash(n) { n = Math.sin(n) * 43758.5453; return n - Math.floor(n); }
  function _vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const a = _hash(xi + yi * 57), b = _hash(xi + 1 + yi * 57), c = _hash(xi + (yi + 1) * 57), d = _hash(xi + 1 + (yi + 1) * 57);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }
  function _fbm(x, y, o) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < o; i++) { s += a * _vnoise(x * f, y * f); f *= 2; a *= 0.5; } return s; }
  function _rgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function proceduralTexture(kind, hex) {
    if (!kind || kind === 'none' || kind === 'glass') return null;
    const key = kind + hex; if (_texCache[key]) return _texCache[key];
    const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(N, N), d = img.data, base = _rgb(hex);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4; let l = 1;
      if (kind === 'wood') {
        const n = _fbm(x * 0.05, y * 0.012, 4);
        const grain = Math.pow(Math.abs(Math.sin((x * 0.08 + n * 7) * Math.PI)), 0.35);
        l = 0.82 + 0.20 * n - 0.30 * (1 - grain) + (_fbm(x * 0.6, y * 0.6, 2) - 0.5) * 0.12;
      } else if (kind === 'metal') { l = 0.92 + (_fbm(x * 0.02, y * 0.7, 3) - 0.5) * 0.16; }
      else if (kind === 'stone') { l = 0.78 + (_fbm(x * 0.09, y * 0.09, 5) - 0.5) * 0.5; }
      else if (kind === 'fabric') { l = 0.92 + (Math.sin(x * 1.6) + Math.sin(y * 1.6)) * 0.05 + (_fbm(x * 0.5, y * 0.5, 2) - 0.5) * 0.1; }
      else if (kind === 'leather') { l = 0.86 + (_fbm(x * 0.25, y * 0.25, 4) - 0.5) * 0.26; }
      else { l = 0.96 + (_fbm(x * 0.15, y * 0.15, 3) - 0.5) * 0.08; }
      l = Math.max(0.3, Math.min(1.3, l));
      d[i] = Math.min(255, base[0] * l); d[i + 1] = Math.min(255, base[1] * l); d[i + 2] = Math.min(255, base[2] * l); d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(2, 2);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    _texCache[key] = tex; return tex;
  }

  function makeMaterial(m) {
    const map = proceduralTexture(m.kind, m.color);
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(m.color),
      roughness: m.roughness, metalness: m.metalness,
      emissive: new THREE.Color(m.emissive || '#000000'),
      transparent: m.opacity < 1, opacity: m.opacity,
      map: map || null,
    });
  }

  const joints = {};        // id -> { type, range, set(value), value, node }
  const hiddenParts = [];   // { mesh, ctrlId, threshold }
  const pickable = [];      // meshes for raycasting
  const partMeshes = {};    // bodyId -> [meshes]  (inspector)
  const partInfo = {};      // bodyId -> { label, geom, color }
  const rootGroups = [];    // { group, base } for explode
  const motionList = [];    // continuously-moving parts (conveyor/spin/oscillate/slide)

  function build(body, parentObj) {
    const jointGroup = new THREE.Group();
    jointGroup.position.set(body.position[0], body.position[1], body.position[2]);
    jointGroup.rotation.set(body.rotation_deg[0] * D2R, body.rotation_deg[1] * D2R, body.rotation_deg[2] * D2R);
    parentObj.add(jointGroup);

    const j = body.joint || { type: 'fixed' };
    const pivot = (j.pivot && j.pivot.length === 3) ? j.pivot : [0, 0, 0];
    const rotator = new THREE.Group();     // carries joint motion
    const inner = new THREE.Group();       // undoes pivot offset for revolute
    rotator.position.set(pivot[0], pivot[1], pivot[2]);
    inner.position.set(-pivot[0], -pivot[1], -pivot[2]);
    jointGroup.add(rotator); rotator.add(inner);

    const mat = makeMaterial(body.material);
    const meshes = makeMeshes(body.geometry, mat);
    for (const m of meshes) { m.castShadow = true; m.receiveShadow = true; m.userData.bodyId = body.id; inner.add(m); pickable.push(m); (partMeshes[body.id] = partMeshes[body.id] || []).push(m); }
    partInfo[body.id] = { label: body.label || body.id, geom: body.geometry.type, color: body.material.color, hidden: !!body.hidden_until_open };
    const mesh = meshes[0];

    if (j.type !== 'fixed') {
      const axis = new THREE.Vector3(j.axis[0], j.axis[1], j.axis[2]).normalize();
      const range = j.range || (j.type === 'revolute' ? [0, 90] : [0, 0.3]);
      const rec = { type: j.type, range, value: j.home || range[0], node: rotator, axis, threshold: range[0] + 0.15 * (range[1] - range[0]) };
      rec.set = function (v) {
        v = Math.max(range[0], Math.min(range[1], v));
        rec.value = v;
        if (j.type === 'prismatic') {
          rotator.position.set(pivot[0] + axis.x * v, pivot[1] + axis.y * v, pivot[2] + axis.z * v);
          rotator.quaternion.identity();
        } else {
          rotator.quaternion.setFromAxisAngle(axis, v * D2R);
        }
        updateHidden();
      };
      joints[body.id] = rec;
      for (const m of meshes) m.userData.articulatedRoot = body.id;
    }

    // continuous motion (conveyor belts, spinning rollers, oscillating arms, sliding pushers)
    let motionRec = null;
    if (body.motion) {
      motionRec = { group: jointGroup, basePos: jointGroup.position.clone(), baseQuat: jointGroup.quaternion.clone(), motion: body.motion, maps: [], items: [], halfLen: 0 };
      if (body.motion.type === 'conveyor') {
        for (const m of meshes) if (m.material.map) { m.material.map = m.material.map.clone(); m.material.map.needsUpdate = true; motionRec.maps.push(m.material.map); }
        const ax = body.motion.axis, sz = body.geometry.size || [0.4, 0.1, 1];
        motionRec.halfLen = 0.5 * (Math.abs(ax[0]) * sz[0] + Math.abs(ax[1]) * sz[1] + Math.abs(ax[2]) * sz[2]);
      }
      motionList.push(motionRec);
    }

    for (const child of (body.children || [])) {
      const childObj = build(child, inner);
      if (child.hidden_until_open) {
        // controlled by the nearest articulated ancestor (this body if it has a joint)
        const ctrl = joints[body.id] ? body.id : mesh.userData.articulatedRoot;
        childObj.traverse(o => { if (o.isMesh) hiddenParts.push({ mesh: o, ctrlId: ctrl }); });
      }
      if (motionRec && body.motion.type === 'conveyor') motionRec.items.push({ group: childObj, base: childObj.position.clone() });
    }
    // propagate articulatedRoot down so deep clicks toggle the right joint
    const rootId = joints[body.id] ? body.id : (parentObj.userData ? parentObj.userData.artRoot : undefined);
    inner.userData.artRoot = rootId;
    return jointGroup;
  }

  function updateHidden() {
    for (const hp of hiddenParts) {
      const ctrl = joints[hp.ctrlId];
      let frac = 1;
      if (ctrl) frac = (ctrl.value - ctrl.range[0]) / Math.max(1e-6, (ctrl.range[1] - ctrl.range[0]));
      const vis = frac > 0.12;
      hp.mesh.visible = vis;
    }
  }

  const world = new THREE.Group(); scene.add(world);
  world.userData.artRoot = undefined;
  for (const b of SPEC.bodies) { const g = build(b, world); rootGroups.push({ group: g, base: g.position.clone() }); }
  updateHidden();

  // ---- camera control (orbit around target) ----
  const target = new THREE.Vector3(SPEC.camera.target[0], SPEC.camera.target[1], SPEC.camera.target[2]);
  let az = SPEC.camera.azimuth_deg, el = SPEC.camera.elevation_deg, dist = SPEC.camera.distance;
  function applyCam() {
    const a = az * D2R, e = Math.max(-89, Math.min(89, el)) * D2R;
    camera.position.set(
      target.x + dist * Math.cos(e) * Math.sin(a),
      target.y + dist * Math.sin(e),
      target.z + dist * Math.cos(e) * Math.cos(a)
    );
    camera.lookAt(target);
  }
  applyCam();

  // pointer orbit + click-to-toggle
  let dragging = false, moved = 0, px = 0, py = 0;
  renderer.domElement.addEventListener('pointerdown', e => { dragging = true; moved = 0; px = e.clientX; py = e.clientY; });
  window.addEventListener('pointerup', e => {
    dragging = false;
    if (moved < 5) tryToggle(e);
  });
  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    az -= dx * 0.35; el += dy * 0.35; applyCam();
  });
  renderer.domElement.addEventListener('wheel', e => { dist *= (1 + Math.sign(e.deltaY) * 0.08); dist = Math.max(0.3, Math.min(20, dist)); applyCam(); e.preventDefault(); }, { passive: false });

  const ray = new THREE.Raycaster();
  function tryToggle(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const hits = ray.intersectObjects(pickable, false);
    if (!hits.length) return;
    let o = hits[0].object, id = null;
    while (o) { if (o.userData && o.userData.articulatedRoot) { id = o.userData.articulatedRoot; break; } o = o.parent; }
    if (!id) { // fall back to artRoot on ancestor groups
      o = hits[0].object;
      while (o) { if (o.userData && o.userData.artRoot) { id = o.userData.artRoot; break; } o = o.parent; }
    }
    if (id && joints[id]) tween(joints[id]);
  }
  function tween(rec) {
    const open = (rec.value - rec.range[0]) < (rec.range[1] - rec.range[0]) * 0.5;
    const to = open ? rec.range[1] : rec.range[0];
    const from = rec.value, t0 = performance.now(), dur = 420;
    function step() {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const s = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      rec.set(from + (to - from) * s);
      if (t < 1) requestAnimationFrame(step);
    }
    step();
  }

  function onResize() { camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); }
  window.addEventListener('resize', onResize);

  // ---- continuous motion animation ----
  const _mv = new THREE.Vector3();
  function positionAt(t) {
    for (const mo of motionList) {
      const m = mo.motion; _mv.set(m.axis[0], m.axis[1], m.axis[2]); const ax = _mv.clone().normalize();
      if (m.type === 'spin') { mo.group.quaternion.copy(mo.baseQuat).multiply(new THREE.Quaternion().setFromAxisAngle(ax, m.rate * t)); }
      else if (m.type === 'oscillate') { const a = (m.range * Math.PI / 180) * Math.sin(2 * Math.PI * t / m.period); mo.group.quaternion.copy(mo.baseQuat).multiply(new THREE.Quaternion().setFromAxisAngle(ax, a)); }
      else if (m.type === 'slide') { const d = m.range * Math.sin(2 * Math.PI * t / m.period); mo.group.position.copy(mo.basePos).addScaledVector(ax, d); }
      else if (m.type === 'conveyor') {
        for (const mp of mo.maps) mp.offset.x = (m.rate * t * 0.6) % 1;
        const L = Math.max(0.001, mo.halfLen * 2);
        for (const it of mo.items) { const ba = it.base.dot(ax); let na = ba + m.rate * t; na = ((na + mo.halfLen) % L + L) % L - mo.halfLen; it.group.position.copy(it.base).addScaledVector(ax, na - ba); }
      }
    }
  }
  let paused = false, playing = true, motionTime = 0, lastT = performance.now();
  function loop() {
    const now = performance.now(), dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    if (!paused) { if (playing && motionList.length) { motionTime += dt; positionAt(motionTime); } renderer.render(scene, camera); }
    requestAnimationFrame(loop);
  }
  loop();

  // ---- headless control API ----
  window.__api = {
    ready: true,
    listJoints() { return Object.keys(joints).map(k => ({ id: k, type: joints[k].type, range: joints[k].range, value: joints[k].value })); },
    setJoint(id, v) { if (joints[id]) joints[id].set(v); render(); },
    setFrac(id, f) { if (joints[id]) { const r = joints[id].range; joints[id].set(r[0] + f * (r[1] - r[0])); render(); } },
    openAll() { for (const k in joints) joints[k].set(joints[k].range[1]); render(); },
    closeAll() { for (const k in joints) joints[k].set(joints[k].range[0]); render(); },
    setCamera(a, e, d) { if (a != null) az = a; if (e != null) el = e; if (d != null) dist = d; applyCam(); render(); },
    focusAt(t, a, e, d) { if (Array.isArray(t)) target.set(t[0], t[1], t[2]); if (a != null) az = a; if (e != null) el = e; if (d != null) dist = d; applyCam(); render(); },
    setView(name) {
      const c = SPEC.camera, d = c.distance;
      const V = { ref: [c.azimuth_deg, c.elevation_deg], front: [0, 6], back: [180, 6], left: [-90, 6], right: [90, 6], side: [90, 6], top: [0, 82], bottom: [0, -70], iso: [35, 30], '34': [35, 25] };
      const v = V[name] || V.ref; az = v[0]; el = v[1]; dist = d; applyCam(); render();
    },
    // ---- inspector ----
    listParts() { return Object.keys(partInfo).map(id => ({ id, ...partInfo[id], joint: joints[id] ? joints[id].type : null })); },
    wireframe(on) { for (const id in partMeshes) for (const m of partMeshes[id]) m.material.wireframe = !!on; render(); },
    _snap(m) { if (m.userData._snap === undefined) m.userData._snap = { op: m.material.opacity, tr: m.material.transparent, em: m.material.emissive.getHex() }; },
    _restore() { for (const id in partMeshes) for (const m of partMeshes[id]) { if (m.userData._snap) { m.material.opacity = m.userData._snap.op; m.material.transparent = m.userData._snap.tr; m.material.emissive.setHex(m.userData._snap.em); } m.visible = true; } updateHidden(); },
    isolate(id) { this._restore(); if (id) for (const k in partMeshes) if (k !== id) for (const m of partMeshes[k]) m.visible = false; render(); },
    hidePart(id, hidden) { for (const m of (partMeshes[id] || [])) m.visible = !hidden; render(); },
    highlight(id) {
      this._restore();
      if (id) { for (const k in partMeshes) for (const m of partMeshes[k]) { this._snap(m); if (k === id) { m.material.emissive.setHex(0x2b6cff); } else { m.material.transparent = true; m.material.opacity = 0.12; } } }
      render();
    },
    explode(f) {
      const c = new THREE.Vector3(target.x, target.y, target.z);
      for (const r of rootGroups) { const dir = r.base.clone().sub(c); if (dir.length() < 0.01) dir.set(0, 1, 0); r.group.position.copy(r.base).add(dir.multiplyScalar(f)); }
      render();
    },
    getState() { return { camera: { az, el, dist, target: [target.x, target.y, target.z] }, joints: this.listJoints() }; },
    setBackground(hex) { scene.background = new THREE.Color(hex); render(); },
    setGround(v) { if (groundMesh) groundMesh.visible = v; render(); },
    hasMotion() { return motionList.length > 0; },
    play(v) { playing = v !== false; },
    setTime(t) { motionTime = t; positionAt(t); render(); },
    resetEnv() { scene.background = new THREE.Color(SPEC.environment.background); if (groundMesh) groundMesh.visible = SPEC.environment.ground.visible; render(); },
    render() { renderer.render(scene, camera); },
  };
  function render() { renderer.render(scene, camera); }
  render();
})();
`;

function esc(s) { return s.replace(/</g, '\\u003c'); }

export function compileHTML(spec) {
  const sceneJSON = esc(JSON.stringify(spec));
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${(spec.meta?.name || 'scene')} — img2env</title>
<style>
  :root{--vb:#e4e4e7;--vb2:#d4d4d8;--vt:#18181b;--vm:#71717a;--vf:#a1a1aa;--va:#2563eb;--vp:#ffffff;--vs:#fafafa}
  html,body{margin:0;height:100%;overflow:hidden;background:${spec.environment.background};
    font-family:'Inter',ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;font-size:13px;color:var(--vt)}
  button,input{font:inherit;color:inherit;border-radius:0}
  #hud{position:fixed;left:12px;top:12px;z-index:10;background:var(--vp);border:1px solid var(--vb);
       padding:8px 11px;line-height:1.45;max-width:280px}
  #hud b{font-weight:600}
  #hud .k{color:var(--vm);font-size:12px}
  /* inspector */
  .vbtn{position:fixed;bottom:12px;z-index:11;height:28px;padding:0 11px;background:var(--vp);
    border:1px solid var(--vb);color:var(--vt);font-size:12.5px;cursor:pointer}
  .vbtn:hover{background:var(--vs);border-color:var(--vb2)}
  #insp-toggle{left:12px}
  #play-toggle{left:86px;display:none}
  #insp-panel{position:fixed;left:12px;bottom:48px;z-index:11;width:250px;max-height:70vh;display:none;flex-direction:column;
    background:var(--vp);border:1px solid var(--vb);font-size:12px}
  #insp-panel.open{display:flex}
  .insp-sec{font-size:11.5px;color:var(--vm);font-weight:500;padding:9px 10px 6px;border-top:1px solid var(--vb)}
  .insp-sec:first-child{border-top:0}
  .insp-views{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;padding:0 10px}
  #insp-panel button{height:26px;background:var(--vp);border:1px solid var(--vb);color:var(--vt);
    padding:0 6px;font-size:11.5px;cursor:pointer}
  #insp-panel button:hover{background:var(--vs);border-color:var(--vb2)}
  .insp-tool{display:flex;align-items:center;gap:8px;padding:0 10px;height:26px;color:var(--vm)}
  .insp-tool input[type=range]{flex:1;min-width:0;appearance:none;background:transparent;height:14px;cursor:pointer;margin:0}
  .insp-tool input[type=range]::-webkit-slider-runnable-track{height:2px;background:var(--vb2)}
  .insp-tool input[type=range]::-webkit-slider-thumb{appearance:none;width:9px;height:13px;margin-top:-6px;background:var(--vt);border:0}
  .insp-tool input[type=range]::-moz-range-track{height:2px;background:var(--vb2)}
  .insp-tool input[type=range]::-moz-range-thumb{width:9px;height:13px;background:var(--vt);border:0;border-radius:0}
  .insp-tool input[type=checkbox]{accent-color:var(--vt)}
  .insp-reset{width:calc(100% - 20px);margin:6px 10px 10px}
  #insp-list{overflow-y:auto;display:flex;flex-direction:column;padding-bottom:4px}
  #insp-list::-webkit-scrollbar{width:9px}
  #insp-list::-webkit-scrollbar-thumb{background:var(--vb2);border:3px solid var(--vp)}
  .insp-row{display:flex;align-items:center;gap:7px;padding:4px 10px;cursor:pointer}
  .insp-row:hover{background:var(--vs)}
  .insp-row.sel{background:#f0f5ff;box-shadow:inset 2px 0 0 var(--va)}
  .insp-row.off{opacity:.4}
  .insp-row .sw{width:10px;height:10px;flex:0 0 auto;border:1px solid rgba(0,0,0,.12)}
  .insp-row .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .insp-row .gm{color:var(--vf);font-size:10.5px}
  .insp-row .acts{display:flex;gap:2px;opacity:0}
  .insp-row:hover .acts,.insp-row.sel .acts,.insp-row.off .acts{opacity:1}
  #insp-panel .insp-row .acts button{height:16px;padding:0 3px;font-size:11px;line-height:1;
    background:transparent;border:0;color:var(--vf)}
  #insp-panel .insp-row .acts button:hover{color:var(--vt)}
</style></head><body>
<div id="hud"><b>${spec.meta?.name || 'scene'}</b><br><span class="k">drag to orbit · scroll to zoom · click drawers &amp; doors</span></div>
<button id="insp-toggle" class="vbtn">Inspect</button>
<button id="play-toggle" class="vbtn">Pause motion</button>
<div id="insp-panel">
  <div class="insp-sec">Camera views</div>
  <div class="insp-views">
    <button data-view="front">Front</button><button data-view="back">Back</button><button data-view="iso">3/4</button>
    <button data-view="left">Left</button><button data-view="right">Right</button><button data-view="top">Top</button>
  </div>
  <div class="insp-sec">Tools</div>
  <label class="insp-tool"><input type="checkbox" id="insp-wire"/> Wireframe</label>
  <label class="insp-tool">Explode <input type="range" id="insp-explode" min="0" max="0.6" step="0.02" value="0"/></label>
  <button id="insp-reset" class="insp-reset">Reset all</button>
  <div class="insp-sec">Parts (<span id="insp-count">0</span>) — click to highlight</div>
  <div id="insp-list"></div>
</div>
<script>/*three*/
${THREE_SRC}
</script>
<script>window.__SCENE__ = JSON.parse(${JSON.stringify(sceneJSON)});</script>
<script>${CLIENT_JS}</script>
<script>(function(){
  var api=window.__api; if(!api) return;
  var parts=api.listParts(), list=document.getElementById('insp-list');
  document.getElementById('insp-count').textContent=parts.length;
  var solo=null, hi=null, hidden={};
  function mark(){ Array.prototype.forEach.call(document.querySelectorAll('.insp-row'),function(r){ r.classList.toggle('sel', r.dataset.id===(solo||hi)); }); }
  parts.forEach(function(p){
    var row=document.createElement('div'); row.className='insp-row'; row.dataset.id=p.id;
    row.innerHTML='<span class="sw" style="background:'+p.color+'"></span><span class="nm">'+p.label+'</span><span class="gm">'+p.geom+(p.joint?' · '+p.joint:'')+'</span><span class="acts"><button title="hide" data-a="eye">&#128065;</button><button title="solo" data-a="solo">&#9678;</button></span>';
    row.querySelector('.nm').onclick=function(){ hi=(hi===p.id?null:p.id); solo=null; api.highlight(hi); mark(); };
    row.querySelector('[data-a=eye]').onclick=function(e){ e.stopPropagation(); hidden[p.id]=!hidden[p.id]; api.hidePart(p.id,hidden[p.id]); row.classList.toggle('off',hidden[p.id]); };
    row.querySelector('[data-a=solo]').onclick=function(e){ e.stopPropagation(); solo=(solo===p.id?null:p.id); hi=null; api.isolate(solo); mark(); };
    list.appendChild(row);
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-view]'),function(b){ b.onclick=function(){ api.setView(b.dataset.view); }; });
  document.getElementById('insp-wire').onchange=function(e){ api.wireframe(e.target.checked); };
  document.getElementById('insp-explode').oninput=function(e){ api.explode(+e.target.value); };
  document.getElementById('insp-reset').onclick=function(){ solo=null;hi=null;hidden={}; api._restore(); api.explode(0);
    document.getElementById('insp-explode').value=0; var w=document.getElementById('insp-wire'); w.checked=false; api.wireframe(false);
    Array.prototype.forEach.call(document.querySelectorAll('.insp-row'),function(r){ r.classList.remove('off','sel'); }); };
  document.getElementById('insp-toggle').onclick=function(){ document.getElementById('insp-panel').classList.toggle('open'); };
  if(api.hasMotion&&api.hasMotion()){ var pb=document.getElementById('play-toggle'); pb.style.display='block'; var on=true;
    pb.onclick=function(){ on=!on; api.play(on); pb.textContent=on?'Pause motion':'Play motion'; }; }
})();</script>
</body></html>`;
}
