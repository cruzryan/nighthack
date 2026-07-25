// SceneSpec: the intermediate representation shared by the compiler (Three.js),
// the renderer, the VLM agents, and the MuJoCo exporter.
//
// A SceneSpec is a KINEMATIC TREE. Every body is a rigid part with a primitive
// geometry, a material, a transform relative to its parent, and an optional
// JOINT connecting it to its parent (fixed | prismatic | revolute). Prismatic =
// a drawer that slides; revolute = a door/lid that swings. Bodies nested inside
// a drawer with `hidden_until_open` are the interior contents (from a 2nd photo)
// that appear when the drawer is pulled out. This tree maps 1:1 to Three.js
// Groups AND to MuJoCo <body>/<joint>, so the same spec drives the viewer and
// the RL env.

export const PRIMITIVES = ['box', 'cylinder', 'sphere', 'cone', 'plane', 'capsule', 'tray', 'frame', 'lathe', 'extrude', 'torus'];
export const JOINT_TYPES = ['fixed', 'prismatic', 'revolute'];

// ---- defaults / normalization ------------------------------------------------

function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
function arr3(v, d) {
  if (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && isFinite(x))) return v.map(Number);
  return d.slice();
}
function hex(v, d) {
  if (typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v.trim())) {
    const s = v.trim(); return s[0] === '#' ? s : '#' + s;
  }
  return d;
}

let _uid = 0;
function ensureId(b, seen) {
  let id = (typeof b.id === 'string' && b.id.trim()) ? b.id.trim().replace(/[^A-Za-z0-9_]/g, '_') : `part_${_uid++}`;
  while (seen.has(id)) id = `${id}_${_uid++}`;
  seen.add(id);
  return id;
}

function normGeom(g) {
  g = g || {};
  let type = PRIMITIVES.includes(g.type) ? g.type : 'box';
  const out = { type };
  if (type === 'tray' || type === 'frame') { out.size = arr3(g.size, [0.5, 0.2, 0.4]); out.wall = num(g.wall, 0.02); }
  if (type === 'box' || type === 'plane') out.size = arr3(g.size, type === 'plane' ? [1, 0.01, 1] : [0.2, 0.2, 0.2]);
  if (type === 'sphere') out.radius = num(g.radius, 0.1);
  if (type === 'cylinder' || type === 'cone' || type === 'capsule') {
    out.radius = num(g.radius, 0.05);
    out.height = num(g.height, 0.2);
  }
  if (type === 'torus') { out.radius = num(g.radius, 0.1); out.tube = num(g.tube, 0.03); }
  if (type === 'lathe') {
    // profile = list of [radius, t] with t in 0..1 (bottom->top); revolved around Y.
    out.height = num(g.height, 0.2);
    out.radius = num(g.radius, 0.06);
    let prof = Array.isArray(g.profile) ? g.profile.filter(p => Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1])).map(p => [Math.max(0.0005, p[0]), Math.min(1, Math.max(0, p[1]))]) : [];
    if (prof.length < 2) prof = [[0.5, 0], [1, 0.1], [1, 0.6], [0.35, 0.85], [0.3, 1]]; // default vessel silhouette (radius as fraction of `radius`)
    prof.sort((a, b) => a[1] - b[1]);
    out.profile = prof;
  }
  if (type === 'extrude') {
    // shape = list of [x,y] polygon points (object-local), extruded along Z by depth.
    out.depth = num(g.depth, 0.05);
    let sh = Array.isArray(g.shape) ? g.shape.filter(p => Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1])).map(p => [Number(p[0]), Number(p[1])]) : [];
    if (sh.length < 3) sh = [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]];
    out.shape = sh;
  }
  out.bevel = Math.min(0.015, Math.max(0, num(g.bevel, 0))); // crisp edges; clamp so it never over-rounds
  return out;
}

const MAT_KINDS = ['wood', 'metal', 'plastic', 'ceramic', 'fabric', 'painted', 'stone', 'glass', 'leather', 'none'];
function normMaterial(m) {
  m = m || {};
  const kind = MAT_KINDS.includes((m.kind || '').toLowerCase()) ? m.kind.toLowerCase() : 'none';
  // sensible PBR defaults per material kind (model can override)
  const def = { wood: [0.62, 0], metal: [0.32, 0.9], plastic: [0.45, 0], ceramic: [0.28, 0], fabric: [0.92, 0], painted: [0.5, 0], stone: [0.85, 0], glass: [0.08, 0], leather: [0.7, 0], none: [0.7, 0] }[kind];
  return {
    color: hex(m.color, '#b0b0b0'),
    roughness: Math.min(1, Math.max(0, num(m.roughness, def[0]))),
    metalness: Math.min(1, Math.max(0, num(m.metalness, def[1]))),
    opacity: Math.min(1, Math.max(0, num(m.opacity, kind === 'glass' ? 0.4 : 1.0))),
    emissive: hex(m.emissive, '#000000'),
    kind,
  };
}

function normJoint(j) {
  if (!j || !JOINT_TYPES.includes(j.type) || j.type === 'fixed') return { type: 'fixed' };
  const axis = arr3(j.axis, [0, 0, 1]);
  let range = Array.isArray(j.range) && j.range.length === 2 ? j.range.map(Number) : (j.type === 'revolute' ? [0, 90] : [0, 0.3]);
  if (range[0] > range[1]) range = [range[1], range[0]];
  return {
    type: j.type,
    axis,
    range,
    home: num(j.home, range[0]),
  };
}

const MOTION_TYPES = ['spin', 'conveyor', 'oscillate', 'slide'];
function normMotion(m) {
  if (!m || !MOTION_TYPES.includes(m.type)) return null;
  const spinLike = m.type === 'spin' || m.type === 'oscillate';
  return {
    type: m.type,
    axis: arr3(m.axis, spinLike ? [0, 1, 0] : [0, 0, 1]),
    rate: num(m.rate, m.type === 'spin' ? 1.2 : m.type === 'conveyor' ? 0.35 : 0.25), // rad/s | m/s | (cycle driver)
    range: num(m.range, m.type === 'oscillate' ? 40 : 0.3),   // deg (oscillate) | m (slide)
    period: Math.max(0.3, num(m.period, 3)),                   // seconds/cycle for oscillate & slide
  };
}

function normBody(b, seen) {
  const out = {
    id: ensureId(b || {}, seen),
    label: typeof b?.label === 'string' ? b.label : '',
    geometry: normGeom(b?.geometry),
    material: normMaterial(b?.material),
    position: arr3(b?.position, [0, 0, 0]),
    rotation_deg: arr3(b?.rotation_deg, [0, 0, 0]),
    joint: normJoint(b?.joint),
    motion: normMotion(b?.motion),
    hidden_until_open: !!b?.hidden_until_open,
    children: Array.isArray(b?.children) ? b.children.map(c => normBody(c, seen)) : [],
  };
  return out;
}

export function normalizeScene(spec) {
  spec = spec || {};
  const seen = new Set();
  const cam = spec.camera || {};
  const env = spec.environment || {};
  return {
    meta: {
      name: (spec.meta?.name || 'scene').toString(),
      units: 'm',
      notes: spec.meta?.notes || '',
    },
    camera: {
      azimuth_deg: num(cam.azimuth_deg, 35),
      elevation_deg: num(cam.elevation_deg, 22),
      distance: num(cam.distance, 3.0),
      target: arr3(cam.target, [0, 0.4, 0]),
      fov_deg: Math.min(55, Math.max(28, num(cam.fov_deg, 42))),
    },
    environment: {
      background: hex(env.background, '#e7ecf1'),
      ground: {
        color: hex(env.ground?.color, '#c8cdd3'),
        size: num(env.ground?.size, 12),
        visible: env.ground?.visible !== false,
      },
    },
    bodies: Array.isArray(spec.bodies) ? spec.bodies.map(b => normBody(b, seen)) : [],
  };
}

// ---- targeted patching (surgical edits from the judge, no whole-spec rewrite)-
// ops: [{op:'modify', id, set:{geometry,material,position,rotation_deg,joint,label,hidden_until_open}},
//       {op:'add', parent:<id|null>, body:{...}}, {op:'remove', id}]
export function applyPatch(spec, ops) {
  const index = new Map();
  (function idx(bodies, parent) { for (const b of bodies || []) { index.set(b.id, { body: b, parent }); idx(b.children, b); } })(spec.bodies, null);
  for (const op of ops || []) {
    try {
      if (op.op === 'modify') {
        const e = index.get(op.id); if (!e) continue;
        const b = e.body, s = op.set || {};
        if (s.geometry) b.geometry = s.geometry;
        if (s.material) b.material = { ...b.material, ...s.material };
        if (s.position) b.position = s.position;
        if (s.rotation_deg) b.rotation_deg = s.rotation_deg;
        if (s.joint) b.joint = s.joint;
        if (s.motion !== undefined) b.motion = s.motion;
        if (s.label != null) b.label = s.label;
        if (s.hidden_until_open != null) b.hidden_until_open = s.hidden_until_open;
      } else if (op.op === 'add' && op.body) {
        const parent = op.parent ? index.get(op.parent)?.body : null;
        if (parent) { parent.children = parent.children || []; parent.children.push(op.body); }
        else (spec.bodies = spec.bodies || []).push(op.body);
      } else if (op.op === 'remove') {
        const e = index.get(op.id); if (!e) continue;
        const arr = e.parent ? e.parent.children : spec.bodies;
        const i = arr.indexOf(e.body); if (i >= 0) arr.splice(i, 1);
      }
    } catch {}
  }
  return normalizeScene(spec);
}

// ---- transform helpers (used to scale + place per-object sub-models) ---------

function scaleGeom(g, s) {
  if (g.size) g.size = g.size.map(v => v * s);
  if (g.radius != null) g.radius *= s;
  if (g.height != null) g.height *= s;
  if (g.tube != null) g.tube *= s;
  if (g.wall != null) g.wall *= s;
  if (g.depth != null) g.depth *= s;
  if (g.type === 'extrude' && g.shape) g.shape = g.shape.map(p => [p[0] * s, p[1] * s]);
  // lathe profile radii are fractions of `radius` (scaled already); leave profile.
}
export function scaleBodies(bodies, s) {
  for (const b of bodies || []) {
    b.position = b.position.map(v => v * s);
    scaleGeom(b.geometry, s);
    if (b.joint && b.joint.type !== 'fixed') {
      if (b.joint.type === 'prismatic' && b.joint.range) b.joint.range = b.joint.range.map(v => v * s);
      if (b.joint.pivot) b.joint.pivot = b.joint.pivot.map(v => v * s);
      if (b.joint.home != null && b.joint.type === 'prismatic') b.joint.home *= s;
    }
    scaleBodies(b.children, s);
  }
}
export function offsetBodies(bodies, dx, dy, dz) {
  for (const b of bodies || []) b.position = [b.position[0] + dx, b.position[1] + dy, b.position[2] + dz];
}

// ---- traversal helpers -------------------------------------------------------

export function forEachBody(spec, fn, parent = null, depth = 0) {
  for (const b of spec.bodies || (parent ? parent.children : [])) {
    fn(b, parent, depth);
    forEachBody({ bodies: b.children }, fn, b, depth + 1);
  }
}

export function countBodies(spec) {
  let n = 0, joints = 0;
  forEachBody(spec, b => { n++; if ((b.joint && b.joint.type !== 'fixed') || b.motion) joints++; });
  return { bodies: n, articulated: joints };  // "moving" = click-joints + continuous motion
}

// ---- world-space AABB + deterministic camera framing ------------------------
// (rotation ignored for framing slack; joints in closed/home state)

function halfExtent(g) {
  if (g.type === 'box' || g.type === 'plane' || g.type === 'tray' || g.type === 'frame') return [g.size[0] / 2, g.size[1] / 2, g.size[2] / 2];
  if (g.type === 'sphere') return [g.radius, g.radius, g.radius];
  if (g.type === 'torus') return [g.radius + g.tube, g.tube, g.radius + g.tube];
  if (g.type === 'lathe') return [g.radius, g.height / 2, g.radius];
  if (g.type === 'extrude') {
    const xs = g.shape.map(p => p[0]), ys = g.shape.map(p => p[1]);
    return [(Math.max(...xs) - Math.min(...xs)) / 2 || 0.1, (Math.max(...ys) - Math.min(...ys)) / 2 || 0.1, g.depth / 2];
  }
  return [g.radius, g.height / 2, g.radius]; // cylinder/cone/capsule
}

export function worldAABB(spec) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  (function rec(bodies, off) {
    for (const b of bodies || []) {
      if (b.hidden_until_open) { rec(b.children, [off[0] + b.position[0], off[1] + b.position[1], off[2] + b.position[2]]); continue; }
      const p = [off[0] + b.position[0], off[1] + b.position[1], off[2] + b.position[2]];
      const e = halfExtent(b.geometry);
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k] - e[k]); hi[k] = Math.max(hi[k], p[k] + e[k]); }
      rec(b.children, p);
    }
  })(spec.bodies, [0, 0, 0]);
  if (!isFinite(lo[0])) { lo = [-0.5, 0, -0.5]; hi = [0.5, 1, 0.5]; }
  return { lo, hi, center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] };
}

// Deterministic cabinet builder: any box/frame carcass with prismatic "drawer"
// children becomes an OPEN-FRONT frame filled with real drawer BOXES (trays) that
// tile the front, sit flush when closed, and slide out into proper open boxes you
// can see into. General for any chest/cabinet — fixes floating-panel drawers and
// gives the shell real depth. (Doors — revolute — are left to the VLM.)
export function repairDrawers(spec) {
  (function visit(bodies) {
    for (const carcass of bodies || []) {
      const g = carcass.geometry;
      if (g && (g.type === 'box' || g.type === 'frame') && Array.isArray(carcass.children) && g.size) {
        const drawers = carcass.children.filter(c => c.joint && c.joint.type === 'prismatic');
        if (drawers.length >= 1) {
          const [W, H, D] = g.size;
          const wall = Math.min(0.025, Math.max(0.012, D * 0.05));
          carcass.geometry = { type: 'frame', size: [W, H, D], wall };
          const n = drawers.length;
          drawers.sort((a, b) => b.position[1] - a.position[1]); // top -> bottom
          const gap = Math.min(0.015, H * 0.03);
          const dh = (H - gap * (n + 1)) / n;
          const dt = Math.max(0.06, D * 0.86);                  // drawer-box depth
          drawers.forEach((dr, i) => {
            const cy = H / 2 - gap - dh / 2 - i * (dh + gap);
            dr.geometry = { type: 'tray', size: [Math.max(0.05, W - 2 * wall - 0.01), Math.max(0.05, dh), dt], wall: 0.014 };
            dr.position = [0, cy, D / 2 - dt / 2];               // front wall flush with cabinet front
            dr.joint = { type: 'prismatic', axis: [0, 0, 1], range: [0, Math.max(0.12, dt * 0.9)], home: 0 };
            reseatDrawerChildren(dr, dt);
          });
        }
      }
      visit(carcass.children);
    }
  })(spec.bodies);
  return spec;
}

// Deterministic attachment fix for LEGS/supports (grimoire joint_attachment rule:
// "no mid-air parts"). Snaps root-level legs vertical, spanning floor→body underside,
// at the body's footprint corners — fixes splayed/floating/gap legs generally.
// GENTLE: only close a real floor GAP under a floating leg by extending it down.
// Preserves the model/judge's leg angle (splay), length intent, and x/z placement —
// so it never fights the review loop. (No mid-air legs, but style is respected.)
export function connectLegs(spec) {
  const roots = spec.bodies || [];
  const legs = roots.filter(b => /\bleg|foot|caster|wheel\b/i.test(b.id + ' ' + (b.label || '')));
  for (const b of legs) {
    const g = b.geometry; if (!g) continue;
    const half = (g.type === 'cylinder' || g.type === 'capsule' || g.type === 'cone') ? g.height / 2 : (g.size ? g.size[1] / 2 : 0.1);
    const bottom = b.position[1] - half;
    if (bottom > 0.04) { // floating: grow downward to the floor, keep the top where it is
      const top = b.position[1] + half, newH = Math.max(0.05, top);
      if (g.type === 'cylinder' || g.type === 'capsule' || g.type === 'cone') g.height = newH; else if (g.size) g.size[1] = newH;
      b.position = [b.position[0], newH / 2, b.position[2]];
    }
  }
  return spec;
}

// GENTLE articulation pass (v3): make declared drawers openable real boxes and
// open the carcass front, WITHOUT retiling/overriding the model's layout — so the
// review loop keeps control of visual fidelity. Respects perceived sizes/positions.
export function ensureArticulation(spec) {
  connectLegs(spec);
  (function visit(bodies) {
    for (const b of bodies || []) {
      const drawers = (b.children || []).filter(c => c.joint && c.joint.type === 'prismatic');
      if (drawers.length && b.geometry && b.geometry.type === 'box' && b.geometry.size) {
        b.geometry = { type: 'frame', size: b.geometry.size, wall: Math.min(0.025, Math.max(0.012, b.geometry.size[2] * 0.05)) };
      }
      const D = (b.geometry && b.geometry.size) ? b.geometry.size[2] : null;
      for (const d of drawers) {
        if (d.geometry && (d.geometry.type === 'box' || d.geometry.type === 'tray') && d.geometry.size) {
          const s = d.geometry.size.slice();
          if (s[2] < 0.05 && D) s[2] = Math.max(0.06, D * 0.82);       // thin panel -> real box depth
          d.geometry = { type: 'tray', size: s, wall: 0.014 };
          if (D) d.position = [d.position[0], d.position[1], D / 2 - s[2] / 2]; // front flush with cabinet front
        }
        const depth = d.geometry.size ? d.geometry.size[2] : 0.3;
        const ax = d.joint.axis || [0, 0, 1];
        const outward = Math.abs(ax[2]) >= Math.max(Math.abs(ax[0] || 0), Math.abs(ax[1] || 0)) ? ax : [0, 0, 1];
        d.joint = { type: 'prismatic', axis: outward, range: [0, Math.max(0.1, depth * 0.9)], home: 0 };
      }
      visit(b.children);
    }
  })(spec.bodies);
  return spec;
}

// seat a drawer's handle on the front face, and its contents down inside the box
function reseatDrawerChildren(dr, dt) {
  const [dw, dhh] = dr.geometry.size;
  for (const c of dr.children || []) {
    if (c.hidden_until_open) {
      c.position = [Math.max(-dw / 2 + 0.06, Math.min(dw / 2 - 0.06, (c.position?.[0] || 0))), -dhh / 2 + 0.05, Math.max(-dt / 2 + 0.06, Math.min(dt / 2 - 0.06, (c.position?.[2] || 0)))];
      continue;
    }
    if (/handle|pull|knob/i.test(c.id + ' ' + (c.label || ''))) {
      if (c.geometry.type === 'box' && c.geometry.size) c.geometry.size[0] = Math.min(c.geometry.size[0], dw * 0.6);
      c.position = [0, Math.max(-0.04, Math.min(0.04, c.position?.[1] || 0)), dt / 2 + 0.02];
    }
  }
}

// Shift all root bodies so the visible scene rests on the floor (min y = 0).
// Fixes "floating" / "sunk" objects and legs-in-the-middle regardless of the
// model's absolute y placement. Idempotent.
export function groundScene(spec) {
  const bb = worldAABB(spec);
  const dy = bb.lo[1];
  if (isFinite(dy) && Math.abs(dy) > 1e-4) for (const b of spec.bodies || []) b.position[1] -= dy;
  return spec;
}

// Bake a correctly-framed camera: keep the model's azimuth/elevation/fov, but
// compute target + distance from the bounding sphere so the object always fills
// the frame (fixes "too zoomed" / "too far" and centers the subject).
export function fitCamera(spec, margin = 1.18) {
  groundScene(spec);
  const bb = worldAABB(spec);
  const sx = bb.hi[0] - bb.lo[0], sy = bb.hi[1] - bb.lo[1], sz = bb.hi[2] - bb.lo[2];
  const radius = 0.5 * Math.sqrt(sx * sx + sy * sy + sz * sz) || 0.6;
  const fov = (spec.camera.fov_deg || 42) * Math.PI / 180;
  spec.camera.target = bb.center;
  spec.camera.distance = margin * radius / Math.sin(fov / 2);
  return spec;
}

// ---- hand-authored example (for token-free testing of the render half) -------

export function exampleScene() {
  return normalizeScene({
    meta: { name: 'nightstand' },
    camera: { azimuth_deg: 35, elevation_deg: 20, distance: 2.4, target: [0, 0.45, 0], fov_deg: 42 },
    environment: { background: '#e9edf2', ground: { color: '#c9ccd1' } },
    bodies: [
      {
        id: 'cabinet',
        geometry: { type: 'box', size: [0.6, 0.7, 0.5], bevel: 0.01 },
        material: { color: '#6f4a2f', roughness: 0.6 },
        position: [0, 0.35, 0],
        children: [
          { id: 'top', geometry: { type: 'box', size: [0.66, 0.03, 0.56], bevel: 0.01 }, material: { color: '#7a5334' }, position: [0, 0.365, 0] },
          {
            id: 'drawer_top',
            geometry: { type: 'tray', size: [0.54, 0.18, 0.46], wall: 0.02 },
            material: { color: '#835a38', roughness: 0.55 },
            position: [0, 0.13, 0.02],
            joint: { type: 'prismatic', axis: [0, 0, 1], range: [0, 0.34], home: 0 },
            children: [
              { id: 'handle_top', geometry: { type: 'cylinder', radius: 0.015, height: 0.14 }, material: { color: '#caa24a', metalness: 0.8, roughness: 0.3 }, position: [0, 0, 0.24], rotation_deg: [0, 0, 90] },
              { id: 'watch', geometry: { type: 'cylinder', radius: 0.045, height: 0.02 }, material: { color: '#222', metalness: 0.6, roughness: 0.4 }, position: [-0.12, -0.06, 0], rotation_deg: [90, 0, 0], hidden_until_open: true },
              { id: 'ball', geometry: { type: 'sphere', radius: 0.05 }, material: { color: '#c0392b' }, position: [0.13, -0.02, -0.05], hidden_until_open: true },
            ],
          },
          {
            id: 'drawer_bot',
            geometry: { type: 'tray', size: [0.54, 0.24, 0.46], wall: 0.02 },
            material: { color: '#835a38', roughness: 0.55 },
            position: [0, -0.12, 0.02],
            joint: { type: 'prismatic', axis: [0, 0, 1], range: [0, 0.34], home: 0 },
            children: [
              { id: 'handle_bot', geometry: { type: 'cylinder', radius: 0.015, height: 0.14 }, material: { color: '#caa24a', metalness: 0.8, roughness: 0.3 }, position: [0, 0, 0.24], rotation_deg: [0, 0, 90] },
              { id: 'book', geometry: { type: 'box', size: [0.2, 0.04, 0.28] }, material: { color: '#2e7d5b' }, position: [0, -0.08, 0], hidden_until_open: true },
            ],
          },
        ],
      },
    ],
  });
}
