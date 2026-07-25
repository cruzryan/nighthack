// SceneSpec -> MuJoCo MJCF (XML). The kinematic tree maps directly: bodies ->
// <body>, prismatic -> <joint type="slide">, revolute -> <joint type="hinge">.
// Three is Y-up; MuJoCo is Z-up, so we remap (x,y,z)_three -> (x,-z,y)_mjcf.
// Rotations are approximated (axis-aligned parts are exact); this is a runnable
// RL-env scaffold, not a pixel-perfect twin.

function v3(p) { return `${p[0].toFixed(4)} ${(-p[2]).toFixed(4)} ${p[1].toFixed(4)}`; }
function axis(a) { const n = Math.hypot(a[0], a[1], a[2]) || 1; return `${(a[0] / n).toFixed(4)} ${(-a[2] / n).toFixed(4)} ${(a[1] / n).toFixed(4)}`; }
function rgba(hex, o = 1) {
  const h = hex.replace('#', ''); const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} ${o.toFixed(2)}`;
}

function geom(b, id) {
  const g = b.geometry, m = b.material, col = rgba(m.color, m.opacity);
  if (g.type === 'sphere') return `<geom name="${id}_g" type="sphere" size="${g.radius.toFixed(4)}" rgba="${col}"/>`;
  if (g.type === 'cylinder' || g.type === 'capsule' || g.type === 'cone') {
    const t = g.type === 'cone' ? 'cylinder' : g.type; // MuJoCo has no cone primitive
    return `<geom name="${id}_g" type="${t}" size="${g.radius.toFixed(4)} ${(g.height / 2).toFixed(4)}" euler="90 0 0" rgba="${col}"/>`;
  }
  // box / plane / tray -> box half-extents
  const s = g.type === 'sphere' ? [g.radius, g.radius, g.radius] : g.size || [0.1, 0.1, 0.1];
  return `<geom name="${id}_g" type="box" size="${(s[0] / 2).toFixed(4)} ${(s[2] / 2).toFixed(4)} ${(s[1] / 2).toFixed(4)}" rgba="${col}"/>`;
}

function jointXML(b, id) {
  const j = b.joint;
  if (!j || j.type === 'fixed') return '';
  if (j.type === 'prismatic') return `<joint name="${id}_j" type="slide" axis="${axis(j.axis)}" range="${j.range[0].toFixed(3)} ${j.range[1].toFixed(3)}"/>`;
  const r0 = (j.range[0] * Math.PI / 180).toFixed(3), r1 = (j.range[1] * Math.PI / 180).toFixed(3);
  const piv = j.pivot ? ` pos="${v3(j.pivot)}"` : '';
  return `<joint name="${id}_j" type="hinge" axis="${axis(j.axis)}" range="${r0} ${r1}"${piv}/>`;
}

// motion -> a driven joint + actuator so the exported model actually MOVES in sim
function motionXML(b, id, acts) {
  const m = b.motion; if (!m) return '';
  if (m.type === 'spin' || m.type === 'oscillate') {
    acts.push(`<velocity name="${id}_m" joint="${id}_mj" kv="1"/>`);
    return `<joint name="${id}_mj" type="hinge" axis="${axis(m.axis)}"/>`;
  }
  // slide / conveyor -> prismatic drive
  acts.push(`<velocity name="${id}_m" joint="${id}_mj" kv="1"/>`);
  return `<joint name="${id}_mj" type="slide" axis="${axis(m.axis)}"/>`;
}

function bodyXML(b, depth, acts) {
  const id = b.id;
  const pad = '  '.repeat(depth);
  const kids = (b.children || []).map(c => bodyXML(c, depth + 1, acts)).join('\n');
  return `${pad}<body name="${id}" pos="${v3(b.position)}">
${pad}  ${jointXML(b, id)}
${pad}  ${motionXML(b, id, acts)}
${pad}  ${geom(b, id)}
${kids ? kids + '\n' : ''}${pad}</body>`;
}

export function toMJCF(spec) {
  const acts = [];
  const bodies = (spec.bodies || []).map(b => bodyXML(b, 2, acts)).join('\n');
  return `<mujoco model="${spec.meta?.name || 'scene'}">
  <compiler angle="radian" coordinate="local"/>
  <option gravity="0 0 -9.81"/>
  <asset>
    <texture name="grid" type="2d" builtin="checker" rgb1="0.8 0.8 0.8" rgb2="0.9 0.9 0.9" width="300" height="300"/>
    <material name="grid" texture="grid" texrepeat="8 8" reflectance="0.1"/>
  </asset>
  <worldbody>
    <light name="top" pos="0 0 3" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="5 5 0.1" material="grid"/>
${bodies}
  </worldbody>
${acts.length ? '  <actuator>\n    ' + acts.join('\n    ') + '\n  </actuator>\n' : ''}</mujoco>
`;
}
