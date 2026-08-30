# View Layer Contract — Corridor Assault

three.js **0.185.1** (installed, verified). Vanilla JS ES modules, **no TypeScript**.
Vite dev server. Portrait-first. Mouse AND touch.

The view layer is a **read-only observer** of sim state. It must never write a sim
field. `src/sim/**` never imports three.js; the view never imports from `sim/`
except for pure data reads passed in as `w`.

## Palette (desert bridge corridor, dusk)

| role | hex | notes |
|---|---|---|
| sand ground | `#C2A878` | |
| road asphalt | `#6E6A63` | |
| road stripe | `#D8CBA6` | |
| railing steel | `#8A8579` | rust stripe `#8C5A3C` every 3rd post |
| sky top / horizon | `#5C6B7A` / `#E0C9A0` | |
| fog | `#D9C39B` | `FogExp2`, density from `CFG.fx.fogDensity` |
| soldier body | `#3E5C78` | helmet brighter `#5B7EA0` |
| soldier ring glow | `#4FC3F7` | additive |
| zombie body | `#7A8A6B` desaturated | rim light `#E0503F` |
| zombie ring | `#E5484D` | |
| barrel healthy / damaged | `#C0392B` / `#5A2A22` | hazard stripes `#E8B93B` on walls |
| bubble shell | `#7FE8FF` | additive fresnel |
| boss | `#6B4A63` | the only violet in the scene |
| muzzle / tracer | `#FFE9B0` / `#FFE08A` | |

Hue is NEVER the primary separator between soldiers and zombies — silhouette and
posture carry it; ring colour only confirms.

## World state you may read

```js
w.runTime, w.distance, w.scroll, w.state           // STATE: 0 READY 1 RUNNING 2 BOSS 3 WON 4 LOST
w.anchorX, w.anchorVelX, w.count, w.tier, w.nominalDPS
w.soldiers  // Pool: .size, .items[i] = { x, z, slotX, slotZ, recoil, recoilVel,
            //   vx, vz, lean, phase, scale, slot, iframe }   vx/vz/lean are VIEW-OWNED
w.zombies   // Pool: .items[i] = { x, z, hp, maxHp, kind:'walker'|'runner'|'brute',
            //   radius, scale, cadence, phase, flash, spawnT }
w.joiners   // Pool: .items[i] = { x, y, z, delay, t }
w.props     // Pool: .items[i] = { kind:'barrel'|'bubble', role:'cheap'|'wall'|'toll',
            //   x, z, hp, maxHp, displayHp, halfW, flash, reward, gatedBy }
w.shockwaves// Pool: .items[i] = { z, gapX, gapW, life }
w.boss      // { active, dead, x, z, hp, maxHp, plateIndex, stagger, raging, phase, flash }
```

**Pools have live items in a contiguous prefix `[0, pool.size)`.** Swap-remove means
indices are NOT stable between frames.

## Module interface

Every view/fx module exports ONE factory returning an object:

```js
export function createThing(scene, deps) {
  return {
    sync(w, dt, alpha, camera),  // per frame, read-only over w
    reset(),                      // instant restart: no dispose, no re-alloc
    dispose(),                    // teardown only, never called during play
  }
}
```

`reset()` must be allocation-free — restart is one frame, under 5ms, and must not
touch the scene graph structure.

## Hard three.js rules (each has a silent failure mode)

1. **`frustumCulled = false` on EVERY InstancedMesh** whose matrices are written at
   runtime. three culls against the geometry bounding sphere at the mesh origin, so
   the whole horde silently vanishes when the camera turns slightly.
2. **Every InstancedBufferAttribute needs its OWN `needsUpdate`**, separate from
   `instanceMatrix.needsUpdate`. Setting only the matrix flag freezes gait and tint
   at boot values while positions animate — a crowd that slides without walking,
   with no console error.
3. **Full matrix rebuild each frame** from `[0, pool.size)`, then set `mesh.count =
   pool.size`. Never track instance indices — swap-remove reordering makes that a
   flicker bug by construction.
4. **Zero allocation in the frame loop.** No object/array literals, no `new
   Vector3/Matrix4/Color`, no `.map/.filter/.forEach` with closures, no `splice`.
   Hoist scratch objects to module scope.
5. **Coplanar-with-road geometry uses `polygonOffset: true, polygonOffsetFactor: -1,
   polygonOffsetUnits: -1`**, NOT a y-lift. A y-lift looks right near the camera and
   z-fights at the far end of the corridor — exactly where the player is reading.
6. **Colour maps get `SRGBColorSpace`; data maps (noise, alpha) stay default.**
7. **No runtime `fillText`.** Bake canvas textures once at boot.
8. **Camera** `near: 1, far: 200` — a 200:1 depth ratio, which kills most road
   z-fighting for free.
9. Refused outright: `EffectComposer`, `UnrealBloomPass`, shadow maps, `PointLight`,
   `MeshPhysicalMaterial` transmission, `BatchedMesh`, `AnimationMixer`,
   `GLTFLoader`, `logarithmicDepthBuffer`, `SkinnedMesh`.

## Geometry / animation approach

Characters are built from primitives, merged into ONE non-indexed `BufferGeometry`
with baked **vertex colours** and a per-vertex `limbId` attribute, then instanced.
There is no `InstancedSkinnedMesh` in three — a `SkinnedMesh` per character would be
200+ draw calls. Limbs animate in a **vertex shader injected via `onBeforeCompile`**,
driven by a per-instance `aPhase` attribute, with a stable `customProgramCacheKey`.
Ship behind a `LIMB_ANIM` flag that zeroes the limb attribute for a static fallback.

Coordinates: **+X right, +Y up, −Z away from the camera (down the corridor).** The
squad sits at `z = 0`; the world scrolls toward `+Z`. Spawn horizon is `z = −72`.

## Camera

`position (0, 6.5, 12.4)`, `fov 62`, looking at `(anchorX*0.25 + velX*0.06, 1.0, −7.5)`.
Lateral follow is **PARTIAL (0.50) with a 0.20s lag** — at 1:1 the squad is pinned to
screen centre and the drag reads as dead even at zero latency.

## Draw call budget

Under 40 total. Instancing line: 16+ concurrent objects sharing geometry+material →
`InstancedMesh`; below it → plain `Mesh` (barrels ≤4, bubbles ≤4, boss 1) since each
needs its own uniforms.
