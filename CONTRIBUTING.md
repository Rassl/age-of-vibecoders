# Contributing to Age of Vibecoders

A squad lane-runner shooter in three.js. Vanilla JS ES modules, **no TypeScript**,
no build-time codegen, no external art assets — every mesh and texture is procedural.

This document exists so that review is about *the change*, not about relitigating the
architecture. The rules below are not style preferences. Each one has a concrete failure
mode attached, most are mechanically checkable in under ten seconds, and **a reviewer is
expected to reject a PR that breaks one** — or to accept an explicit, argued exception,
recorded in the PR.

Read `docs/SPEC.md` for *why* the numbers are what they are, and `docs/VIEW_CONTRACT.md`
for the render layer's own rules. This file is the short, enforceable version.

---

## 1. Setup

Requires **Node ≥ 20.19** (or ≥ 22.12) — Vite 8 declares `engines: ^20.19.0 || >=22.12.0`
and will refuse to run on older 20.x. npm is the package manager; `package-lock.json` is
committed and CI runs `npm ci`, so **lockfile changes must be committed with the change
that caused them**.

```bash
git clone <repo> && cd age-of-vibecoders
npm install
npm run dev        # opens the printed URL
```

Runtime dependencies are exactly one: `three`. Adding a second is a discussion, not a PR.

**Controls:** drag left/right (mouse or touch), `R` restarts. The squad fires by itself.

---

## 2. Running things

| Command | What it does | Needs a browser? |
|---|---|---|
| `npm run dev` | Vite dev server, HMR | you, yes |
| `npm run build` | production build into `dist/` | no |
| `npm run preview` | serve the built `dist/` | you, yes |
| `node tools/harness.mjs` | **firewall check + config validation + balance table** | no |
| `node tools/sweep.mjs` | parameter sweep, prints the skill gradient | no |
| `node tools/sweep.mjs '[{"threat.betaBase":0.12}]'` | sweep any `CFG` path | no |
| `node tools/smoke.mjs 20` | loads the real game, console errors + screenshots | **yes**, + a server |
| `node tools/playthrough.mjs` | autopilots a full run, screenshots each act | **yes**, + a server |
| `node tools/perf.mjs` / `profile.mjs` / `smooth.mjs` | frame-time instrumentation | **yes**, + a server |

> **Run the harness from the repo root.** It resolves `src/sim` relative to the current
> working directory, so `cd tools && node harness.mjs` fails with `ENOENT`, not with a
> useful message.

The five browser tools drive **a browser you already have**: `playwright-core` ships none,
and `tools/chrome.mjs` resolves the binary — `$CHROME_PATH` wins if set, otherwise the
usual install locations for your platform.

They also **attach to a server you have already started — none of them starts one.** All
five load `http://localhost:5180/`, and `npm run dev` defaults to 5173, so give it the
port:

```bash
npx vite --port 5180                                  # terminal 1
node tools/smoke.mjs 20                               # terminal 2
CHROME_PATH=/path/to/chrome node tools/smoke.mjs 20   # if Chrome is somewhere unusual
GAME_URL=http://localhost:5173/ node tools/playthrough.mjs
```

`GAME_URL` is read by `smoke.mjs` and `playthrough.mjs` only — `perf`, `profile` and
`smooth` hard-code 5180. All five also still pass `--use-angle=metal`, a macOS-only ANGLE
backend; if one fails to get a GPU context on Linux, that flag is the first thing to drop.

They are deliberately local-only and **never run in CI** — there is no browser on the
runner and we do not download one.

---

## 3. The invariants

### 3.1 The firewall: `src/sim` imports no three.js and subscribes to no bus topic

`src/sim/**` is the simulation. It must not `import ... from 'three'`, and it must not
call `bus.on(...)`.

**Why.** Because the sim has no renderer, it runs headless — which is the entire reason
*"is this a sim bug or a render bug?"* is an answerable question instead of an afternoon.
It is also what lets `tools/harness.mjs` play ninety-one full runs — six skill levels ×
five seeds, three times over, plus one traced run — in about a second.

**Why the bus is one-directional.** Sim **emits facts**; presentation **listens**. The
bus drains once per frame in the view layer, so a subscriber registered from `sim/` would
make sim→sim causality implicit *and* frame-delayed. Sim→sim causality is a direct
function call. `src/reactions.js` is where a sim event becomes presentation — the
only other `bus.on` in the whole tree is a single `RUN_OVER` handler in `src/main.js` that
sequences the end card. That is what keeps "what happens when a barrel dies" readable in
one file instead of scattered across nine systems.

**How to check.**

```bash
node tools/harness.mjs | head -1
# firewall: OK -- src/sim imports no three.js and subscribes to no bus topic (15 files)
```

A violation prints `FIREWALL VIOLATION` or `BUS VIOLATION` with the offending file and
**exits 1**. CI gates on both the exit code and that `firewall: OK` line.

Self-check without the harness — both must print nothing:

```bash
grep -rn "from 'three'" src/sim
grep -rn "bus\.on" src/sim
```

Related, same reason: **`Math.random` is banned in `src/sim`, `src/curves.js` and
`src/data`.** Use the seeded mulberry32 in `src/util/rng.js` so any run is reproducible
from its seed. That is the precondition for the balance rule in §4.

### 3.2 Tick order is data

`src/sim/systems.js` exports a flat `SYSTEMS` array. **Each entry's position in that array
is a design decision with a documented failure mode**, and the array is the whole
simulation — there is no hidden ordering anywhere else.

Three positions that are load-bearing, as examples of the standard:

- `scroll` runs **before** `collision`. Move-after-test gives a barrel one free frame of
  overlap, which is exactly the one-frame unfairness players read as the game cheating.
- `drones` and `bolts` run **before** `targets`/`fire`, so a bolt queued this step is
  settled by the same `flushDamage` pass as the squad's own shots. After, and every drone
  hit lands one full step behind its own explosion.
- `damage` → `blasts` → `damage2`: a bloater's blast is queued as ordinary damage and
  settled by a *second* flush, so a chain resolves one link per step instead of recursing.

**The rule.** Adding, removing, or moving an entry in `SYSTEMS` is a **design change, not
a refactor.** A PR that touches the array must:

1. State, in the PR body, which ordering bug the new position prevents — or which one it
   accepts.
2. Carry a comment above the entry naming the failure mode, in the style of the ones
   already there. An entry whose position has no stated reason is an unowned decision.
3. Include harness before/after output (§4) — reordering systems changes sim output, so
   the balance rule applies whether or not you touched a number.

"I moved it up so the lint/order/import graph is tidier" is a rejection.

`SYSTEMS` is also the debugging tool: `runStep` skips any system whose name is in the
exported `disabled` `Set`, so a gameplay bug is bisected by name instead of by commenting
out code. Nothing toggles it for you yet — there is no debug overlay, and the DEV-only
`window.__game` does not expose the Set — so today it costs one temporary line. Keep names
short, stable and unique anyway: they are the handles that workflow uses.

### 3.3 Read `CFG` at the use site — never destructure at module load

```js
// NO -- frozen at import time
import { CFG } from '../config.js'
const { anchorTau } = CFG.squad
const SPACING = CFG.formation.spacingBase

// YES -- read where it is used
function steer(w, dt) {
  const k = 1 - Math.exp(-dt / CFG.squad.anchorTau)
  ...
}
```

**Why.** `src/config.js` is THE tuning table and it is meant to be mutated live.
`tools/sweep.mjs` literally walks a dotted path into `CFG` and assigns a new value *after*
every module has already been imported. A module-scope copy silently ignores that write,
so you sweep, read a number off the table, and tune against a value the shipped game is
not using. There is no error — the run just quietly disagrees with the tool.

A local alias **inside a function body**, re-read on every call, is fine. Capturing at
module scope is what is banned. `FIXED_DT` is a genuine compile-time constant and is
imported directly; that is the only exception.

Self-check — every top-level line under `src/` that reads `CFG`:

```bash
grep -rn "^\(const\|let\|var\).*CFG\." src | grep -v config.js
```

Today that returns three lines, all legitimately boot-only: the camera constructed in
`src/main.js`, a pool-derived count in `src/fx/damagenumbers.js`, and a comment in
`src/view/corridor.js`. A **fourth** line is your PR's problem to justify.

New numbers go **in `config.js`**, next to their siblings, with a comment saying what
the number is for. A magic literal in a system is a rejection.

### 3.4 Zero allocation on the frame path

Nothing reachable from `runStep()` or a view `sync()` may allocate. Banned inside that
call graph:

- object and array literals
- `new Vector3` / `Matrix4` / `Color` / anything (hoist scratch objects to module scope)
- `.map` / `.filter` / `.forEach` with closures
- `splice` for removal — **swap-remove only**

**Why.** GC sawtooth in a 60fps drag-controlled runner is felt directly as input lag, and
it is routinely misdiagnosed as a control problem. A flat JS heap line across a full run
is the acceptance criterion.

The structural rules that hold this up, which a PR must not quietly break:

- **Pools with swap-remove.** Live items are a contiguous prefix `[0, pool.size)`.
  Indices are **not** stable between frames — never store one.
- **Two-phase death.** Mark `dead = true`; a single `reap` pass at a fixed point in
  `SYSTEMS` releases. This makes triple-kill-in-one-substep idempotent.
- **Generation-tagged handles**, so a deferred impact cannot damage a recycled entity.
- **Bus payloads come from a pre-allocated ring** with a fixed monomorphic shape
  (`{ topic, x, y, z, a, b, c, kind }`). Never add a field at runtime; never emit an
  object.
- `resetWorld()` (`src/sim/world.js`) must be allocation-free: restart is one frame,
  under 5ms, and must not touch the scene graph's structure.

### 3.5 No runtime `fillText`

**Every** number and word the player reads in the world — barrel HP, bubble reward badges,
floating damage — is a textured quad sampling **one 512×512 glyph atlas baked once at
boot** in `src/view/atlas.js`. Updating a barrel's number writes one float into an
instanced UV-cell attribute.

**Why.** Re-rasterising a 512² RGBA canvas is ~1MB of texture upload, and four barrels
ticking their HP at once puts four of those in a single frame — which is, by construction,
the busiest frame in the run.

Printing a new word means **extending `GLYPH_CHARS` and re-baking**, not drawing at
runtime. The atlas's channel layout is a contract: alpha is coverage, **red is the fill
mask** so glyphs can be tinted while their outline stays dark. Read the header comment
before you touch it.

Self-check — the only *call* may be the bake in `src/view/atlas.js`:

```bash
grep -rn "fillText" src
# src/view/atlas.js:5    -- comment
# src/view/atlas.js:91   -- ctx.fillText(ch, 0, 0)   <- the one bake, at boot
# src/view/characters.js:627 -- comment
```

The HUD (`src/ui/hud.js`, `src/ui/overlay.js`) is the only DOM *interface* in the project:
everywhere else `document` appears, it is `main.js` grabbing its four root elements or a
procedural canvas texture baked once at boot. Text in the HUD is free; text in the world
is not.

### 3.6 Refused APIs

Not "discouraged". Refused, each for a stated reason in `docs/SPEC.md`:

`EffectComposer` / `UnrealBloomPass` / any post-process bloom · shadow maps ·
`PointLight` (any light beyond the one hemisphere + one directional key) · `SkinnedMesh` ·
`AnimationMixer` · `GLTFLoader` · `logarithmicDepthBuffer` · `WebGPURenderer` ·
`MeshPhysicalMaterial` transmission · `BatchedMesh` · `CSS2DRenderer` · `Raycaster` for
gameplay · octrees / BVH / `three-mesh-bvh` / any physics library.

Also refused: **external art assets of any kind** (no textures, no models, no fonts —
everything is procedural), and any new runtime dependency.

Rendering rules that fail *silently* and so get their own line in review — the full list
is in `docs/VIEW_CONTRACT.md`:

- `frustumCulled = false` on **every** `InstancedMesh` whose matrices are written at
  runtime, or the whole horde vanishes when the camera turns slightly.
- Every `InstancedBufferAttribute` needs its **own** `needsUpdate`, separate from
  `instanceMatrix.needsUpdate` — otherwise gait and tint freeze at boot values while
  positions animate, with no console error.
- Coplanar-with-road geometry uses `polygonOffset`, never a y-lift.
- Colour maps get `SRGBColorSpace`; data maps stay default.
- The view is a **read-only observer** of sim state. It never writes a sim field.

---

## 4. THE BALANCE RULE

> **Any PR that changes a number in `src/config.js`, `src/curves.js`, or `src/data/**`
> must paste before/after `node tools/harness.mjs` output in the PR description.**
> So must any PR that changes `SYSTEMS` order or sim logic that could move the numbers.

**Why this is a real gate and not paperwork.** The harness is **deterministic on fixed
seeds**: six bot skill levels × five seeds (`1000 + s * 7919`), bot RNG derived from the
run seed, seeded mulberry32 throughout, `Math.random` banned in the sim. Two consecutive
runs on an unchanged tree produce **byte-identical output**. Therefore every line that
differs between your before and after table was caused by *your change* and by nothing
else. That is a rare and cheap thing to have, and it is the reason this rule is worth the
thirty seconds it costs.

```bash
git stash                                   # get back to the unmodified tree
node tools/harness.mjs > /tmp/before.txt
git stash pop
node tools/harness.mjs > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

Paste the **after** table plus the **diff** into the PR (or both tables if the diff is
large). CI attaches its own `harness.txt` run as a build artifact, so a reviewer can
always regenerate the "after" side themselves.

**Baseline: ~21/30 wins** across the six skill levels × five seeds. A change that moves
the total by more than a win or two needs an argument, not just a number.

**The harness cannot fail your PR on balance, and that is deliberate.** It exits non-zero
only on a firewall/bus violation or a non-finite config value. Nothing in CI can decide
whether 18/30 is better than 21/30 — the table is evidence for a human reviewer, and the
reviewer's job is to read it.

### 4.1 How to read the harness output

Four blocks. Block one is the balance table:

```
skill      aim  outcome   run    boss  peak end tier  dps  boss%  kills  bub+/- brch lost
------------------------------------------------------------------------------------------
COMPETENT  0.78 LOSS      102.2      -    35   0    1   508     -    308    4/14    4   52    wins 2/5
```

| column | meaning |
|---|---|
| `skill` / `aim` | bot label and **aim efficiency** — the fraction of nominal DPS actually delivered. Bullets go straight and you aim with your body, so a bot that cannot hold a lane both decides late and tracks sloppily. This is the load-bearing skill axis. |
| `outcome` | `WIN` / `LOSS` / `TIMEOUT` for the **representative run only** (seed 1000). |
| `run` | seconds the representative run lasted. |
| `boss` | seconds spent in the boss fight; `-` means the boss was never reached. |
| `peak` / `end` | peak squad size / soldiers alive at the end. Soldier count *is* health, damage and score, in one number. |
| `tier` | weapon tier reached, `0..4` (pistol → SMG → rifle → shotgun → minigun). |
| `dps` | peak nominal squad DPS. |
| `boss%` | boss HP remaining, as a percent. `0` is a clean kill; `-` is never reached. |
| `kills` | zombies killed. |
| `bub+/-` | bubbles **taken / missed**. Missing one costs nothing, so a high miss count is a *choice* signal, not a failure signal. |
| `brch` | barrels that reached the squad. Each takes a bite proportional to remaining HP. |
| `lost` | soldiers lost. |
| `wins N/5` | **the number that matters.** Wins across all five seeds at this skill level. Every other column on the row is seed 1000 only, for texture. |

**Block two, loss causes:** individual soldiers lost, summed over five seeds, split by
`zombie` (contact), `breach` (a barrel reached the plane), `shock` (boss shockwave) and
`boss`. This is how you tell *which* pressure your change moved. A tuning change that
holds the win rate but converts every breach loss into a zombie loss has changed the game
substantially and needs saying so.

**Block three, weapon axis:** how many weapon tier-ups the bot actually claimed, one
number per seed. `MAX_TIER` is 4, so 4 is a full sweep (the printed `(of 3 offered)`
header is stale). All 4s means upgrades have become free and the toll is no longer a real
toll; all 1s means the toll is eating the whole reward track.

**Block four, representative timeline** (COMPETENT, seed 1000, every 10s):

```
t50: n=29 tier=1 dps=421 par=159 z=7 props=4
```

`n` squad size · `tier` weapon tier · `dps` nominal squad DPS · **`par` the DPS the
economy expects at that moment** (`parDPS()` in `curves.js`) · `z` live zombies ·
`props` live barrels and bubbles. **`dps` sliding under `par` is the leading indicator**:
a run that falls behind the curve loses the boss DPS check later, and the timeline shows
you the exact ten-second window where it happened.

### 4.2 What "good" looks like

A healthy build shows a **monotone gradient** — wins and peak squad size fall as aim gets
worse. `tools/sweep.mjs` prints `MONOTONE` when a configuration achieves it across nine
seeds, and is the right tool for *exploring* a number before you commit to it:

```bash
node tools/sweep.mjs
node tools/sweep.mjs '[{"threat.betaBase":0.12},{"threat.betaBase":0.16}]'
```

**Be honest about the instrument.** With five enemy kinds — including a ranged spitter and
an exploding bloater — the scripted bot in `tools/bot.mjs` is no longer a great proxy for
a human: it dodges acid only once the glob is airborne, never during the spitter's windup,
which is the telegraph a human actually reads; it has no notion of a bloater's blast radius
at all; and its lane valuation is greedy over the props on screen right now. The reported
gradient is consequently flatter and noisier than it should be. So: treat a single row
swinging by one win as noise, look at the **total and the shape**,
and do not tune to three decimal places against this bot — that is fitting noise. If you
improve `bot.mjs`, that is a change worth making on its own, and the balance rule applies
to it too.

---

## 5. Pull requests

Keep them small and single-purpose. Describe the failure mode you fixed or the decision
you made, not the diff — the diff is already in the PR.

### PR checklist

Paste this into the PR body and tick it:

```markdown
- [ ] `npm run build` succeeds
- [ ] `node tools/harness.mjs` (from repo root) prints `firewall: OK` and `config: OK`
- [ ] No `three` import and no `bus.on` anywhere under `src/sim/`
- [ ] No `Math.random` in `src/sim`, `src/curves.js` or `src/data`
- [ ] `CFG` is read at the use site; nothing destructured at module load
- [ ] No new allocation on the frame path (no literals, `new`, closures or `splice`
      reachable from `runStep()` or a view `sync()`)
- [ ] No runtime `fillText`; new glyphs go through `src/view/atlas.js` and are baked at boot
- [ ] No refused API (§3.6) and no new dependency or external art asset
- [ ] If `SYSTEMS` order changed: the new position's failure mode is stated here AND
      commented in `src/sim/systems.js`
- [ ] **If any number in `src/config.js`, `src/curves.js` or `src/data/**` changed:
      before/after `tools/harness.mjs` output is pasted below, with a sentence on what
      moved and why that is the intended direction**
- [ ] Tried it with an actual thumb, or said explicitly that I did not
```

### Grounds for rejection

Firewall or bus violation · a `SYSTEMS` reorder with no stated reason · a `CFG` value
captured at module load · an allocation on the frame path · runtime `fillText` · a refused
API · a new dependency or art asset · **a balance change with no harness output**.

An exception to any of these is allowed if it is *argued in the PR* and a reviewer agrees.
An exception that arrives silently is not.

---

## 6. What CI runs

`.github/workflows/ci.yml`, on every push and pull request, on Node 20:

1. `npm ci`
2. `npm run build` — the production Vite build must succeed
3. `node tools/harness.mjs` — non-zero exit fails the job, and the job additionally
   **greps for `firewall: OK`**, so the architecture check cannot regress into a warning
   that nobody reads. The harness output is uploaded as a build artifact.

CI deliberately runs **nothing that needs a browser**. `playwright-core` ships no browser
and the tools drive one you already have (`tools/chrome.mjs`, `$CHROME_PATH` to override);
a runner has none, so the smoke, playthrough and perf tools stay local. Frame-time and "does it actually feel good" remain human jobs — and
nobody has yet played this with a real thumb on a real phone, which is the only test that
settles a drag game.
