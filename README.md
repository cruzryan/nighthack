# img2env — photo(s) → interactive, articulated 3D environment (for RL)

Drop in a photo (or several) and img2env reconstructs it into an **interactive 3D world** you
can orbit and manipulate — **drawers slide open, doors swing, and drawer contents appear when
you pull them out**. The same scene exports to **MuJoCo (MJCF)** so it's a runnable RL
environment. Keep chatting to refine it, or add more photos (new angles / interiors) to enrich
it and correct sizes & distances.

Inspired by [hoainho/img2threejs](https://github.com/hoainho/img2threejs) (spec-driven,
deterministic compiler + VLM only for visual judgment), but built around **articulation for RL**,
**multi-image enrichment**, **metric scale**, and **MuJoCo export**.

## What it does

```
photo(s) ─▶ PERCEIVE (VLM → SceneSpec) ─▶ COMPILE (Three.js) ─▶ RENDER (headless)
                     ▲                                                   │
                     └──────── REFINE ◀── CRITIQUE (VLM + deterministic image match) ◀┘
                          (hill-climb loop, keeps the best)
```

- **SceneSpec** — one kinematic tree (bodies + primitives + materials + joints). Maps 1:1 to
  both a Three.js scene and a MuJoCo model. `prismatic` = drawer, `revolute` = door/lid.
- **Deterministic reward** — a white-background render is compared to the photo (silhouette IoU,
  aspect, colour, fill) for a *smooth* score, so the refine loop can actually hill-climb. The VLM
  supplies the *semantic* fixes ("legs too light", "add 4th drawer").
- **Deterministic guards** — camera auto-framing, scene grounding (rests on the floor), fov
  clamp, and a few-shot worked example keep even a cheap model producing clean geometry.
- **Interactive output** — a single self-contained HTML (Three.js inlined). Drag to orbit,
  scroll to zoom, **click a drawer/door to open it**.

## Run it

```bash
npm install
npx playwright install chromium      # one-time (headless WebGL renderer)
npm start                            # → http://localhost:5188
```

Open the URL, drop a photo, add an optional description, hit **Build environment**. Then:
- **Chat to refine** — "make the wood darker walnut", "the top drawer should open further".
- **Add more images** — drop a new angle or an *inside-the-drawer* photo and it enriches the model.
- **Metric scale** — say "make it exactly 1.5 m wide" or "the items are 1 m apart" and it rescales.
- **Export** — download `scene.json` or the **MuJoCo** `.xml`; **↗** opens the standalone viewer.

`.env` holds `OPENAI_API_KEY` (+ optional `GEMINI/ANTHROPIC`). Model tiers: `fast` = gpt-4o-mini
(~$0.04/build), `balanced` = gpt-4.1-mini, `quality` = gpt-4.1.

## MuJoCo / RL

The exported MJCF loads and steps in MuJoCo; each drawer/door becomes a named joint = an action
dimension:

```python
import mujoco
m = mujoco.MjModel.from_xml_path("scene.xml")   # 4 slide joints for a 4-drawer dresser
d = mujoco.MjData(m); d.qpos[0] = 0.2
for _ in range(50): mujoco.mj_step(m, d)         # drawer opens, simulates
```

## Layout

| path | role |
|---|---|
| `src/scene.js` | SceneSpec schema, normalization, AABB, camera-fit, grounding |
| `src/viewer.js` | SceneSpec → self-contained interactive Three.js HTML |
| `src/render.js` | Playwright headless renderer (deterministic states) |
| `src/agents.js` | VLM agents: perceive / critique / refine (+ schema, few-shot) |
| `src/metric.js` | deterministic image-match reward |
| `src/pipeline.js` | the reconstruct + refine loops |
| `src/mjcf.js` | SceneSpec → MuJoCo MJCF exporter |
| `src/server.js` + `public/` | local web app (no login, in-memory + disk-rehydrated sessions) |
| `test/` | `smoke` (render), `ab_models` (model A/B), `e2e_ui`, `enrich` |

## Known limitations / next

- Drawers are flush front panels (crisp when closed); contents rest at the drawer plane rather
  than in a modelled tray. Good enough to "see inside"; a tray-per-drawer would be more literal.
- Shape fidelity is a rough primitive approximation (no meshing/photogrammetry). Multi-view helps.
- Reward's shape term is coarse; a stronger critic model or true multi-view pose solve would push
  fidelity further.
