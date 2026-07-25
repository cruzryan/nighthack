// The three VLM agents: perceive (image -> scene), critique (render vs photo),
// refine (scene + instructions [+ new images] -> better scene). All share one
// SceneSpec schema. The reward here is VISUAL: the critic scores its own render
// against the source photo, and refine acts on the discrepancies.
import { visionJSON } from './openai.js';
import { normalizeScene, countBodies } from './scene.js';

const SCHEMA_DOC = `
SceneSpec JSON schema (units = METERS, Y is UP, ground plane at y=0):
{
  "meta": { "name": string, "notes": string /* your scale assumptions */ },
  "camera": { "azimuth_deg": n, "elevation_deg": n, "distance": n, "target":[x,y,z], "fov_deg": n },
  "environment": { "background": "#rrggbb", "ground": { "color":"#rrggbb", "visible": bool } },
  "bodies": [ Body, ... ]
}
Body = {
  "id": "unique_snake_case",
  "label": "human name (e.g. 'top drawer')",
  "geometry": PICK THE ONE THAT MATCHES THE PART'S SHAPE (never a box for a round thing):
      {"type":"box","size":[w,h,d],"bevel":0..0.01}        // panels, slabs, carcasses, blocky parts
      {"type":"cylinder","radius":r,"height":h}            // legs, rods, cups, cans, pipes (axis = Y)
      {"type":"sphere","radius":r}                         // fruit, balls, knobs, domes
      {"type":"cone","radius":r,"height":h}                // tapers, tips
      {"type":"capsule","radius":r,"height":h}             // rounded limbs, soft rods
      {"type":"torus","radius":r,"tube":t}                 // rings, rims, ring-handles, tires
      {"type":"lathe","radius":r,"height":h,"profile":[[rad,tY],...]}  // ROUND VESSELS: bottle, jug, vase, lamp, bowl, pot. profile = list of [radius(0..1 of r), heightFraction(0..1 bottom→top)] — trace the silhouette, e.g. a bottle: [[0.9,0],[0.95,0.6],[0.3,0.75],[0.28,1]]
      {"type":"extrude","shape":[[x,y],...],"depth":d}     // flat shaped parts: plates, blades, letters, non-box cross-sections
      {"type":"frame","size":[w,h,d],"wall":0.02}          // OPEN-FRONT cabinet shell (leave carcass a plain "box" — the builder converts it)
      {"type":"tray","size":[w,h,d],"wall":0.02},          // open-top bin/basket
  "material": {"color":"#rrggbb","kind":"wood|metal|plastic|ceramic|fabric|leather|painted|stone|glass","roughness":0..1,"metalness":0..1,"opacity":0..1},  // set "kind" so the surface gets the right texture (wood grain, brushed metal, etc.) — this is important for realism
  "position": [x,y,z],          // RELATIVE TO PARENT body center (root bodies are relative to world; y=0 is floor)
  "rotation_deg": [rx,ry,rz],   // fixed mounting orientation
  "joint": {                    // how this body MOVES relative to its parent (omit or {"type":"fixed"} if static)
      "type":"prismatic"|"revolute"|"fixed",
      "axis":[x,y,z],           // prismatic: slide direction (drawer pulls along +z if it faces +z). revolute: hinge axis
      "range":[min,max],        // prismatic: meters of travel (~90% of drawer depth). revolute: degrees (door ~[0,110])
      "pivot":[x,y,z],          // revolute ONLY: hinge point in this body's local frame (put it at the hinge EDGE)
      "home": min
  },
  "motion": {                   // OPTIONAL continuous motion — makes MACHINES run (for factories/mechanisms)
      "type":"conveyor"|"spin"|"oscillate"|"slide",
      "axis":[x,y,z],           // conveyor/slide travel direction, or spin/oscillate rotation axis
      "rate": n,                // spin: rad/s · conveyor & slide: m/s · (oscillate uses period)
      "range": n,               // oscillate: degrees of swing · slide: meters of travel
      "period": n },            // seconds per cycle (oscillate & slide)
  "hidden_until_open": bool,    // TRUE for items INSIDE a drawer/cabinet: they appear only when its parent opens
  "children": [ Body, ... ]     // sub-parts (handles, contents). positions are relative to THIS body.
}`;

const RULES = `
MODELING RULES:
- DECOMPOSE — a recognizable object is NEVER one block. Break it into its real parts and give each its own body + primitive + color. Aim for: simple object ≥4 parts, moderate ≥8, detailed/complex ≥12. A plain box that "roughly" matches is a FAILURE.
- CLASSIFY THE SURFACE BEFORE PICKING A PRIMITIVE (topology): a smooth continuously-varying volume (bottle, jug, vase, horn, dome, any revolved/organic mass) is "continuous-sculpt" → use lathe/extrude/cone, NEVER box or plain cylinder. A rigid flat-faced part (crate, panel, chassis) is "assembled-solid" → box/cylinder OK. A long thin strand (cable, rope, stem, wire) → thin cylinder/capsule, NEVER box. A ring/rim → torus. Balls/fruit → sphere. Using a box for a continuous-sculpt is the #1 failure — do not.
- ATTACHMENT (no floating parts): every appendage must physically CONNECT to what it's attached to. LEGS: vertical, their TOP touches the body's underside and their BOTTOM reaches the floor — never splayed at an angle or floating with a gap. HANDLES: sit flush on the drawer/door face. Place parts so joints touch; do not leave air gaps.
- CAPTURE THE SILHOUETTE. If the body has TIERS, STEPS, TAPERS, angled facets, a protruding top, a base/plinth, or moldings, model each as its OWN box/shape (stack/rotate them). Match overall proportions (width:height:depth) to the photo.
- Build ONE kinematic tree. The main object is a root body; panels/drawers/doors/handles/contents are nested children. Child positions are relative to the PARENT's center.
- The outer body / carcass / cabinet shell / dresser box is ALWAYS a SOLID "box" (never a tray). Only use "tray" for a bin/basket/open drawer interior that is genuinely open in the photo.
- Sit objects ON the floor: the carcass bottom must rest at world y=0. If the carcass box has height H and stands on legs of height L, its center y = L + H/2.
- CHEST OF DRAWERS / dresser: carcass = solid box (width W, height H, depth D). Each drawer is a THIN "box" FRONT PANEL: size ≈ [W-0.03, H/nDrawers-0.02, 0.03], its front just proud of the carcass front face (child position z ≈ +D/2, so it sits ON the front surface, NOT inside). Stack the panels vertically to tile the whole front (child position y from +H/2 down to -H/2). Each drawer: joint "prismatic", axis = outward front normal (usually [0,0,1]), range [0, ~0.35], home 0.
  · Handle: a child of the drawer panel — a thin HORIZONTAL bar (box [0.15..0.5, 0.02, 0.03] or a cylinder rotated 90° about z) centered on the panel front (z ≈ +0.02).
  · Contents (from an interior photo): children of the drawer with "hidden_until_open": true, placed BEHIND the panel (z negative, inside the carcass) resting near the drawer floor — they hide when closed and emerge when it slides out.
- LEGS: 4 thin boxes/cylinders under the carcass corners, top touching the carcass bottom, bottom at y=0. Give them their real (often darker) color.
- MOVING MACHINERY (factories, mechanisms, vehicles): if a part continuously MOVES, give it "motion". A conveyor belt → type "conveyor" (axis = belt travel direction); put the cargo/boxes on it as children — they ride the belt automatically. A spinning roller/wheel/fan/turntable/gear → "spin". A robot arm / lever / pendulum that swings → "oscillate". A piston / pusher / lift → "slide". Model the machine as real parts (belt slab + side rails + support legs + end rollers; a robot as base + arm segments) so the motion is legible. This is how we bring a factory to life.
- DOORS: thin "box" panel, joint "revolute", axis vertical [0,1,0], pivot at the hinge vertical edge (local x = ±width/2), range [0,110].
- LIDS: revolute, horizontal hinge axis, pivot at the back edge.
- SILHOUETTE & DETAIL: match the object's overall proportions and distinctive shape. If it has TIERS, STEPS, TAPERS, angled facets, a protruding top, a plinth/base, or moldings, build them as extra stacked/rotated boxes — don't collapse everything into one plain block. More correctly-placed parts = more detail.
- EDGES: keep edges CRISP. Use bevel 0 for most furniture; only add a tiny bevel (≤0.01) if the real piece is visibly rounded. Never over-round.
- COLORS: give the true surface albedo (ignore shadows/highlights). Distinct parts (legs, handles, panels) get the distinct colors seen in the photo.
- MATERIAL KIND: set material.kind on every part (wood/metal/plastic/ceramic/fabric/leather/painted/stone/glass) so it renders with the right surface — a wooden carcass is "wood" (gets grain), a metal handle is "metal", a ceramic jug is "ceramic". This is important for realism.
- CAMERA: set azimuth (0 = front face, 90 = right side) and elevation (deg above horizon) to MATCH the photo's viewpoint. Distance/target are auto-framed for you, so approximate distance is fine; just get the ANGLE right.
SCALE & DISTANCE (critical for RL):
- Estimate real-world sizes in meters from cues (a mug ~0.09 m tall, a drawer ~0.4 m wide, a door ~0.9 m). State assumptions in meta.notes.
- If the user's text gives sizes/distances ("cabinet is 1 m wide", "items are 1 m apart", "camera 2 m away"), OBEY them exactly and set positions/sizes/camera.distance accordingly.
- Multiple objects: lay them out on the floor at their real relative distances.`;

// A concrete worked example so even a small model copies exact proportions.
// KEY: a drawer FRONT PANEL is wide + tall but THIN in depth ([w, h, 0.03]),
// sitting flush at z = +carcassDepth/2. Legs sit BELOW the carcass (negative y).
const EXAMPLE = `
WORKED EXAMPLE — a nightstand ~0.5m wide, 0.55m tall, 0.4m deep, on 4 legs, with 2 drawers.
Copy this STRUCTURE and the way dimensions are laid out; adapt sizes/colors/counts to the photo.
{
 "meta":{"name":"nightstand","notes":"assumed 0.5m wide from typical nightstand size"},
 "camera":{"azimuth_deg":35,"elevation_deg":16,"distance":2,"target":[0,0.4,0],"fov_deg":42},
 "environment":{"background":"#eef1f4","ground":{"color":"#c8cdd3","visible":true}},
 "bodies":[
  {"id":"carcass","label":"body","geometry":{"type":"box","size":[0.5,0.45,0.4],"bevel":0.006},
   "material":{"color":"#7a5334","roughness":0.6},"position":[0,0.425,0],
   "children":[
     {"id":"drawer_top","label":"top drawer","geometry":{"type":"box","size":[0.46,0.19,0.03]},
      "material":{"color":"#835a38"},"position":[0,0.11,0.2],
      "joint":{"type":"prismatic","axis":[0,0,1],"range":[0,0.33],"home":0},
      "children":[
        {"id":"handle_top","geometry":{"type":"box","size":[0.16,0.02,0.03]},"material":{"color":"#2b2b2b","metalness":0.6,"roughness":0.4},"position":[0,0,0.025]},
        {"id":"sock","label":"sock inside","geometry":{"type":"box","size":[0.1,0.05,0.1]},"material":{"color":"#c0392b"},"position":[0,-0.05,-0.14],"hidden_until_open":true}
      ]},
     {"id":"drawer_bot","label":"bottom drawer","geometry":{"type":"box","size":[0.46,0.19,0.03]},
      "material":{"color":"#835a38"},"position":[0,-0.11,0.2],
      "joint":{"type":"prismatic","axis":[0,0,1],"range":[0,0.33],"home":0},
      "children":[{"id":"handle_bot","geometry":{"type":"box","size":[0.16,0.02,0.03]},"material":{"color":"#2b2b2b","metalness":0.6},"position":[0,0,0.025]}]}
   ]},
  {"id":"leg_fl","geometry":{"type":"cylinder","radius":0.02,"height":0.2},"material":{"color":"#3a2a1c"},"position":[-0.21,-0.325,0.17]},
  {"id":"leg_fr","geometry":{"type":"cylinder","radius":0.02,"height":0.2},"material":{"color":"#3a2a1c"},"position":[0.21,-0.325,0.17]},
  {"id":"leg_bl","geometry":{"type":"cylinder","radius":0.02,"height":0.2},"material":{"color":"#3a2a1c"},"position":[-0.21,-0.325,-0.17]},
  {"id":"leg_br","geometry":{"type":"cylinder","radius":0.02,"height":0.2},"material":{"color":"#3a2a1c"},"position":[0.21,-0.325,-0.17]}
 ]
}
Note: drawer panels are [0.46, 0.19, 0.03] — WIDE, TALL, THIN — placed at z=+0.2 (=carcassDepth/2) so they sit flush on the front. Legs are children placed BELOW the carcass (y negative) so their bottoms reach the floor. Handles/contents are children of the drawer so they move with it.`;

export async function perceive({ images, prompt, model }) {
  const system = `You are a 3D reconstruction engine. You look at photo(s) of a real object/scene and emit a SceneSpec that, when rendered, matches the photo AND is INTERACTIVE (drawers slide, doors swing) so it can serve as a reinforcement-learning environment.\n${SCHEMA_DOC}\n${RULES}\n${EXAMPLE}\nReturn ONLY the JSON object.`;
  const user = `Reconstruct this into a SceneSpec.${prompt ? `\nUser guidance: ${prompt}` : ''}\nIf multiple images are given they show the SAME scene from different angles or the interior of a drawer/cabinet — fuse them into one model. Identify every part that can move and articulate it. Return ONLY JSON.`;
  const { json, usage } = await visionJSON({ model, system, user, images, maxTokens: 6000 });
  return { spec: normalizeScene(json), raw: json, usage };
}

export async function critique({ realImage, renderImages, spec, model }) {
  const system = `You are a meticulous QA reviewer comparing a REAL photo to a 3D RENDER of a reconstruction, both from the same camera. You find every visible discrepancy and give concrete, quantitative fixes.\nReply ONLY with JSON:\n{\n  "score": 0..1,           // holistic visual match (shape, proportions, colors, layout, articulation plausibility)\n  "matches": [string],      // what is already right\n  "discrepancies": [ { "part": string, "issue": string, "severity": "high"|"med"|"low" } ],\n  "fix_instructions": string // a precise, imperative paragraph telling the modeler EXACTLY what to change (sizes in m, colors in hex, positions, add/remove parts, camera). \n}`;
  const parts = countBodies(spec);
  const user = `IMAGE 1 = the REAL photo (ground truth).\nIMAGE 2..N = the current 3D render (same camera; one may show drawers/doors OPEN to reveal interior).\nCurrent model has ${parts.bodies} bodies, ${parts.articulated} moving joints. Current SceneSpec (for reference):\n${JSON.stringify(spec).slice(0, 6000)}\n\nCompare carefully. Where do proportions, colors, part count, layout, or camera differ? Be specific and quantitative. Return ONLY JSON.`;
  const { json, usage } = await visionJSON({ model, system, user, images: [realImage, ...renderImages], maxTokens: 2500 });
  return {
    score: Math.max(0, Math.min(1, Number(json.score) || 0)),
    matches: json.matches || [],
    discrepancies: json.discrepancies || [],
    fix: json.fix_instructions || '',
    usage,
  };
}

// ---- v3: generic perception (NO leakage) + render-review-patch loop ----------

const OPS_DOC = `
A PATCH is a list of ops that surgically edit the spec (do NOT rewrite the whole thing):
- {"op":"modify","id":"<existing body id>","set":{ any of geometry, material, position, rotation_deg, joint, label, hidden_until_open }}
- {"op":"add","parent":"<id or null for root>","body":{ full Body object }}
- {"op":"remove","id":"<existing body id>"}`;

export async function perceiveRich({ images, userHint = '', model }) {
  const system = `You are a 3D reconstruction engine. Look at the photo and rebuild the object(s) as a structured part hierarchy that, rendered, looks like the reference AND is interactive (drawers slide, doors/lids hinge). Perceive everything FROM THE IMAGE — do not assume a generic template.\n${SCHEMA_DOC}\n${RULES}\n${EXAMPLE}\nReturn ONLY the JSON object.`;
  const user = `Reconstruct the object(s) in this image, working ONLY from what you can see. Identify what it is, decompose it into EVERY visible part, choose the primitive that matches each part's true shape (round vessels → lathe with a traced profile; do not approximate a round object as a box), match the proportions and per-part colors you observe, and mark how each part moves. Do not invent parts you cannot see.${userHint ? `\nUser guidance (obey if given): ${userHint}` : ''}\nReturn ONLY JSON.`;
  const { json, usage } = await visionJSON({ model, system, user, images, maxTokens: 6000 });
  return { spec: normalizeScene(json), raw: json, usage };
}

// One call: score fidelity vs the reference AND return a surgical patch to improve it.
export async function reviewAndPatch({ spec, refImage, renderImages, model, round = 1 }) {
  const system = `You are the reviewer+editor in a 3D reconstruction loop (like a sculptor checking their work against a photo).
IMAGE 1 = the REAL reference. The remaining images = renders of the CURRENT reconstruction: front, left, right, BACK, TOP, and a final OPEN+IN-MOTION shot (drawers/doors open, machines mid-motion). Use ALL of them.
Judge how faithfully the reconstruction matches the reference OBJECT: correct PARTS present, correct SHAPE/primitive, correct PROPORTIONS, correct per-part COLORS, correct LAYOUT, and plausible ARTICULATION. IGNORE background, exact camera framing, and lighting — those are not fidelity.

MULTI-ANGLE / PHYSICAL-PLAUSIBILITY (check across ALL the render angles — this catches the worst errors):
- CROSS-ANGLE CONSISTENCY: a part that looks fine head-on but is offset, jumbled, twisted, or floating from a side angle is WRONG — score it low and fix it.
- NO MID-AIR PARTS: every part must physically connect. LEGS must reach the floor AND touch the body's underside (no gap, not splayed at an angle). HANDLES must sit flush on the drawer/door face. Panels must not float.
- STACKED PARTS SHARE AN AXIS: tiers/drawers/shelves stacked vertically must line up on a common vertical axis and be flush — not zig-zag at random offsets. If they stair-step, that is an error unless the reference clearly shows it.
- These structural errors matter MORE than color — fix them first.

Then output a surgical PATCH that fixes the MOST IMPORTANT problems this round (structural/floating/misaligned first, then shape/proportion/missing-parts, then colors).
${SCHEMA_DOC}
${OPS_DOC}
PER-FEATURE GATING: list the object's 3-6 IDENTITY-DEFINING features (the things that make it look like THIS specific object — e.g. "faceted zig-zag tiers", "4 flush drawers", "splayed angled legs", "honey wood grain") and score EACH 0-1. A feature scores low if it's wrong from ANY angle. You may ONLY verdict "pass" if fidelity ≥ 0.85 AND every critical feature ≥ 0.7. Otherwise "refine", and your ops MUST target the lowest-scoring features first.
Return ONLY JSON:
{
  "fidelity": 0.0-1.0,
  "features": [ {"name": string, "score": 0.0-1.0, "critical": true|false} ],
  "verdict": "pass" | "refine",
  "summary": "one line: the lowest-scoring feature + fix",
  "articulation_ok": true|false,
  "ops": [ ... ]                 // [] if pass. Use the RIGHT primitive (lathe/extrude/etc). Add missing parts, remove invented ones, fix shapes/proportions/positions/colors, set material.kind, set correct joints (drawers=prismatic, doors/lids=revolute).
}`;
  const user = `Round ${round}. Current spec (edit via ops, do not rewrite):\n${JSON.stringify(spec).slice(0, 9000)}\n\nScore fidelity + per-feature, then return the patch targeting the weakest features. Be bold enough that fidelity actually rises this round. ONLY JSON.`;
  const { json, usage } = await visionJSON({ model, system, user, images: [refImage, ...renderImages], maxTokens: 4000 });
  const features = Array.isArray(json.features) ? json.features : [];
  const critFail = features.some(f => f.critical && Number(f.score) < 0.7);
  let verdict = json.verdict === 'pass' ? 'pass' : 'refine';
  if (critFail) verdict = 'refine'; // a broken critical feature can't pass, whatever the global score
  return {
    fidelity: Math.max(0, Math.min(1, Number(json.fidelity) || 0)),
    features,
    verdict,
    summary: json.summary || '',
    articulation_ok: !!json.articulation_ok,
    ops: Array.isArray(json.ops) ? json.ops : [],
    usage,
  };
}

export async function refine({ spec, instructions, images = [], userMessage = '', model }) {
  const system = `You are a 3D reconstruction engine editing an EXISTING SceneSpec. Apply the requested changes and return the COMPLETE corrected SceneSpec (not a diff).\n${SCHEMA_DOC}\n${RULES}\nPreserve body ids and parts that are already correct. Only change what the instructions require. Return ONLY the JSON object.`;
  const imgNote = images.length ? `\n${images.length} image(s) are attached — they may be NEW ANGLES or interior views of the same scene; use them to correct geometry, add revealed parts, and fix distances/sizes.` : '';
  const user = `Current SceneSpec:\n${JSON.stringify(spec)}\n\nChange request: ${userMessage || instructions}${instructions && userMessage ? `\nAlso apply these QA fixes: ${instructions}` : ''}${imgNote}\nReturn the full corrected SceneSpec as ONLY JSON.`;
  const { json, usage } = await visionJSON({ model, system, user, images, maxTokens: 6000 });
  return { spec: normalizeScene(json), raw: json, usage };
}
