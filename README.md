<img width="1122" height="1402" alt="image" src="https://github.com/user-attachments/assets/6787fc90-7409-414a-b634-e051adbcb89b" />


# Age of Vibecoders

A squad lane-runner shooter in three.js. You drag; the squad fires by itself; every few
seconds the corridor offers you two rewards and enough time to shoot your way to exactly
one of them.

An independent, from-scratch implementation inspired by the squad-runner mode in
*Age of Origins* by Camel Games. Every line of code, every mesh, texture, glyph and
sound in this repository is original and generated procedurally at boot — there is not
a single image, audio, font or model file in the tree, and no assets, code or data were
extracted from any other game. ~13k lines of vanilla JS ES modules, one runtime
dependency (three 0.185.1), no TypeScript.

Needs **Node ≥ 20.19** (or ≥ 22.12) — Vite 8 declares that in `engines` and refuses
to start on older 20.x.

```bash
npm install
npm run dev        # then open the printed URL
npm run build      # static bundle in dist/ -- base is './', so it deploys anywhere
```

**Controls:** drag left/right — mouse or touch. `A`/`D` or arrow keys also work.
`R` restarts. That is the entire control scheme. There is no fire button and no auto-aim:
bullets travel straight down `-Z` from each soldier's muzzle, so *you aim with your body*,
and that single decision is what everything else in the design hangs off.

**Three run modes**, cycling with the NG+ round (`?mode=advance|hold|turret` pins one):

- **ADVANCE** (round 1, 4, 7…) — the lane-runner above. You drag the squad.
- **HOLD THE LINE** (round 2, 5…) — the squad plants, the road stops, the horde walks in.
- **MAN THE GUN** (round 3, 6…) — a mounted gun on the truck behind the squad. *You drag
  the gun*, sweeping a laser sight across the road; the squad steers itself with the
  harness bot's lane policy (`src/sim/autopilot.js`) and fires as always. The turret's ray
  is the one shot in the game that leaves at an angle, so it can break the toll the squad
  is not standing behind, pop a spitter in the other lane, or prime a bloater early. Its
  damage is a fixed slice of par (`CFG.turret.dpsFrac`), priced like a drone's, so barrels
  stay priced against the squad and the gun is pure surplus — what it buys is the *second*
  lane, if you can hold it.

On a wide window the game letterboxes to a portrait stage instead of showing acres of
empty desert with the squad as a speck. Drag distance is resolution-independent: crossing
the 9-unit corridor always costs 55% of the window width or 300 physical pixels, whichever
is smaller, on any screen.

## The run

110 seconds of corridor, then a boss. A winning run takes about two minutes end to end —
median 121s across the harness's 21 wins, sixteen of which finish inside 130s. The
corridor is a fixed 110s, so every bit of that spread is the boss: 8s to 50s depending on
the squad that shows up, which is the fight doing its job as a grade rather than a wall.

Content spawns at a fixed **72-unit horizon** and scrolls toward a squad that never moves
forward. That horizon divided by the scroll speed is the **window** — the seconds of fire
you get on anything before it reaches you. Scroll ramps 14 → 18 u/s across the run, so the
window closes from 5.14s to 4.00s. Every price in the game is quoted as a fraction of it.

**Beats** arrive every ~5.5s from an authored table (`src/data/encounters.js`: 18 beats,
8 gate rows, 3 scripted sweeps — that file *is* the level design). The signature beat is a
**pair**: two lanes, each with a red **toll barrel** in front and a reward **bubble** 7
units behind it. Barrels block bullets, so the toll literally gates the reward — break the
barrel, then the bubble, inside one window. The math says you can afford one lane.

- **13 pair beats, 23 bubbles**: 12 pay soldiers (2–8 bodies who sprint in and join, two of
  them double), 5 pay a permanent weapon tier-up for the whole squad, 3 pay an escort
  drone, and 3 (the energy can at 32s, 54s and 76s, standing in the open with no toll, badge `FLY`) give the squad **wings**: ten
  seconds airborne, out of reach of every body, acid glob and shockwave on the road,
  still shooting — but still paying barrels and gate rows (`CFG.wings`). Missing one
  costs you nothing, ever — `bubble.missPenalty` is 0 and is meant to stay 0. Punishing
  a miss teaches players to avoid the most interesting decision in the game.
- **Five weapons**, and you start on the worst: pistol → SMG → rifle → shotgun → minigun,
  1.0× → 4.3× damage. Each has its own mesh on every soldier, its own fire rate, spread,
  pellet count, pierce and tracer character; the minigun's barrels visibly spin up. A run
  that banks its upgrades ends 4.3× stronger per soldier than one that does not. At max
  tier a weapon bubble pays bodies instead, so it is never wasted.
- **Five enemies**, unlocking on a schedule (walker 0s, runner 25s, bloater 30s, spitter
  40s, brute 55s). Two of them change what you have to *do*: the **spitter** stops at
  range and lobs acid into the lane you are standing in, so it cannot be dodged
  indefinitely — it has to be shot, which competes with the barrel you were aiming at. The
  **bloater** detonates on death and the blast chews through whatever crowd it was standing
  in, so killing it early pays. Brutes take three soldiers on contact. **All of them block
  bullets**, so a crowd in front of a barrel is a DPS shield — the third axis of the
  allocation game.
- **Gate plates** are the steering axis, on their own table and their own cursor. A row of
  panels tiles the corridor rail to rail with no gap, each printing a signed number, and
  you pass through exactly one — so the question is never *whether* to engage, only which
  value to take. Shooting a plate walks its number **up**, at a cost priced in seconds of
  your own DPS (0.30s per point), so a plate climbs at the same rate for a 3-soldier pistol
  squad and a 40-soldier minigun squad. A plate also stops bullets, which is the trade:
  rows spawn at 34u rather than 72u so the fire blackout is ~2 seconds instead of five.
  Authored values run from +3 down to −14, and a negative is capped against the live squad
  at spawn time, so what the panel prints is what it costs.
- **Escort drones** are the deliberate exception to "bullets go straight". A drone targets
  off-axis and lobs a homing bolt, answering the one threat body-aiming cannot: something
  alive in a lane you are not in. That is exactly why pickups are timed (38s, three slots).
  You deploy with one permanent escort at 5% of par DPS — a scout that plinks — because a
  mechanic the player never sees is not a mechanic. Bought drones hit at 75% of par.
- **Walls** span the whole corridor and are mandatory. **Barrels print their remaining HP**,
  and one that reaches you takes a bite out of the squad proportional to the HP left — a
  near-kill is nearly free, ignoring one is brutal.
- **Soldier count is your health, your damage and your score.** One number, 3 → 40. The only
  fail condition is reaching zero, which always takes sustained failure: 0.7s i-frames cap
  the bleed, and both the barrel breach cap (60%) and the gate penalty cap (70%) are floored
  at `n-1`, so no single event can ever take the last soldier.
- **The boss** is a DPS check on the squad you actually built — a score readout, not the
  difficulty peak (the crescendo at t≈96–103 is where the build is really judged). Its HP
  blends par and your actual DPS (4,600–14,400), three armour plates each buy you a 1.2s
  stagger, and slams are the entire damage model: a shockwave with a 4.6u gap that moves
  every time, so what kills you is always visible and always dodgeable. It rages after 30s.

## Why the numbers are what they are

The whole economy is `src/config.js` (the tuning table) and `src/curves.js` (the same
economy as pure functions). Two decisions carry it.

**A toll costs seconds, not hit points.** If barrel HP scaled slower than your DPS, the
greedy lane would get cheaper the stronger you got and the decision would decay to nothing
by mid-run. Setting `barrel.lambdaUp.toll = 1.0` makes time-to-kill exactly DPS-invariant:

```
t=60, toll barrel        par DPS   675 hp   3.36s
                       2x par DPS  1350 hp   3.36s
```

Every toll from t=27 onward costs 3.2–3.4s of fire whether you have 5 soldiers or 40 (the
tutorial toll at t=16 costs 2.3s), so taking both lanes of a pair stays impossible.
Mandatory content (walls, `lambdaUp 0.55`) blends *below* 1.0 on purpose, so it gets
genuinely easier as you grow and a weak squad is never walled out.

**Demand is deliberately oversubscribed.** Horde plus cheap lane plus toll lane costs
1.3–1.6× the window through acts 2–4 (0.62× at the tutorial beat, 0.40× at the mercy beat
before the boss). Above 1.0 you must choose; below it the mode has no decisions.

`docs/SPEC.md` carries a per-constant rationale for the rest, and its tuning table is kept
current — but its file manifest and opening sections have drifted (a four-tier weapon table
against the five that shipped, and `sim/scroll.js` / `sim/reap.js` modules that were folded
into `systems.js`). Where they disagree, the code is the authority.

## Architecture

Six rules. They are not style preferences; each one buys a specific property, and the
first is checked mechanically on every harness run.

**1. Nothing under `src/sim` imports three.js, and nothing there subscribes to the bus.**
The simulation is plain data and plain functions, so it runs in bare node at whatever speed
the CPU allows. That is what makes *"sim bug or render bug?"* an answerable question instead
of an afternoon, and it is the precondition for the balance harness playing the real game
rather than a model of it. The bus half of the rule is just as load-bearing: sim emits
**facts**, presentation listens, and sim→sim causality is a direct function call. The bus
drains once per *frame*, so a sim→sim subscription would be silently frame-delayed and
would fire once for a 3-substep frame. `tools/harness.mjs` greps every file under `src/sim`
and exits non-zero on either violation.

**2. Tick order is data.** `src/sim/systems.js` exports a flat `[{name, fn}]` array and
`runStep` walks it. No registration side effects, no priority numbers, no auto-discovery —
reading that one array tells you the complete causal structure of the game. Every position
is a decision with a failure mode written next to it: scroll runs *before* collision because
move-after-test gives a barrel one free frame of overlap (the one-frame unfairness players
correctly read as the game cheating); `director` runs *last* so new content is priced
against the squad `roster.commit` just finalised; damage is flushed *twice* so a bloater
chain resolves one link per step instead of recursing. Reordering entries is a gameplay
change, and should be reviewed as one.

**3. Read `CFG` at the use site — never destructure at module load.** `const { anchorTau } =
CFG.squad` at the top of a file freezes that value at boot and silently defeats live
retuning, hot patching and the sweep tool. Always `CFG.squad.anchorTau`, inline, every time.

**4. Pools, two-phase death, generation-tagged handles.** Every entity is a plain object in
a fixed-capacity pool allocated at boot (220 zombies, 4096 particles, 320 rings…). Removal
is swap-remove, so live objects stay contiguous — which means you must iterate *backwards*
whenever you may release. Nothing is ever destroyed where it dies: systems set `dead = true`
and a single `reap` pass at the end of the step releases, so three systems killing the same
zombie in one step is idempotent. Reaping bumps a per-slot generation counter, and deferred
impacts carry the generation they were issued against, so a delayed hit cannot damage the
fresh entity that recycled into that slot.

**5. Zero allocation on the frame path.** Pools are pre-filled at boot; the event bus is a
ring of 2,048 pre-allocated records with a fixed monomorphic shape `{topic,x,y,z,a,b,c,kind}`
(never add a field at runtime — that is why the damage-number system matches targets
*spatially* rather than by id). There is **no runtime `fillText`**: every number the player
reads in world space samples one 512×512 glyph atlas baked once at boot
(`src/view/atlas.js`). Re-rasterising that canvas costs ~1MB of texture upload, and four
barrels ticking their HP at once would put four of those into the busiest frame of the run.
The DOM HUD writes transform and opacity only, through a cached last value, and never reads
`offsetWidth` — one layout-triggering read inside `sync()` produces sporadic 8ms spikes that
look exactly like a GPU problem and get debugged as one for a day.

**6. Banned, permanently:** `EffectComposer`/bloom, shadow maps, `PointLight`, `SkinnedMesh`,
`AnimationMixer`, `GLTFLoader`, `logarithmicDepthBuffer`, `WebGPURenderer`, `Raycaster` for
gameplay, any physics library, and any external art or audio asset. The look is carried by
clipped highlights, additive tracers, instanced geometry and a baked palette instead; the
sound is synthesised, with a crowd-fire bed replacing individual voices past ~9 shots/sec so
a big squad gets *bigger* rather than louder.

Two bugs are worth recording because both were invisible to every test that existed, and
both are why the rules above are written down:

- **Drag was silently discarded on any frame that ran zero fixed substeps** — 58% of finger
  movement on a 144Hz display, and throughout every hitstop, so the squad went unresponsive
  for ~130ms after each barrel explosion. The harness calls `runStep` directly and the
  playthrough writes `targetXRaw`, so `Loop` and `Input` were never exercised together.
  `pendingDx` now accumulates across frames and clears only once a substep has consumed it.
- **The minigun's pierce shot through toll barrels into the bubble behind them**, deleting
  the pair beat's gating mechanic for the entire back half of a run. Pierce now cuts through
  bodies only (`castRay` breaks on any non-zombie blocker).

## The harness

```bash
node tools/harness.mjs
```

Two jobs. First it asserts the firewall and validates every config leaf is finite (the
no-TypeScript safety net), printing:

```
firewall: OK -- src/sim imports no three.js and subscribes to no bus topic (15 files)
config: OK
```

Then it plays **real runs** — the shipped `curves.js`, the shipped `systems.js`, no model —
with bots at six aim efficiencies × five fixed seeds, and prints one representative run per
level plus the win count:

```
skill      aim  outcome   run    boss  peak end tier  dps  boss%  kills  bub+/- brch lost
GOOD       0.86 WIN       118.9    8.9    40  38    4  1720     0    908   10/10    1    9    wins 3/5
```

`peak`/`end` are squad size, `tier` the weapon reached, `bub+/-` bubbles taken vs missed out
of 20, `brch` barrels that reached the squad, `lost` soldiers killed. Below the table it
breaks losses down by cause (zombie / breach / shockwave / boss), reports weapon tier-ups
per run, and prints one run's trajectory sampled every 10 seconds — squad size, tier, DPS
against par — so you can see exactly where a build diverges.

**It is deterministic on fixed seeds, so any balance change must come with before/after
output.** The baseline at HEAD is **21/30 wins**. `.github/workflows/ci.yml` runs the
production build and this harness on every push and pull request, and greps its output for
`firewall: OK` so the architecture check cannot decay into a warning nobody reads. It makes
no pass/fail judgement on balance — that table is printed and uploaded for a human.

Aim efficiency is the modelled skill because it is the load-bearing one: bullets go straight
and you aim with your body, so a player who cannot hold a lane delivers a fraction of
nominal DPS. A healthy build shows a *monotone* gradient — wins and peak squad size falling
as aim gets worse. **The current one does not** (EXPERT 2/5, CLUMSY 5/5); see the open work
below.

```bash
node tools/sweep.mjs                                 # baseline skill gradient, 6 levels x 9 seeds
node tools/sweep.mjs '[{"threat.betaBase":0.12}]'    # sweep any config path
```

Browser checks drive a Chrome you already have — `playwright-core` ships none.
`tools/chrome.mjs` finds the binary: `$CHROME_PATH` wins if set, otherwise it tries the
usual install locations for macOS, Linux and Windows. They expect a dev server at
`http://localhost:5180`, so run `npx vite --port 5180` — plain `npm run dev` serves 5173
and every probe below will fail to connect:

```bash
export CHROME_PATH=/usr/bin/chromium   # only if it cannot find one itself

node tools/smoke.mjs 20     # boots the real game, reports console errors + screenshots
node tools/playthrough.mjs  # autopilots a full run to the boss, screenshots each act
node tools/perf.mjs         # rAF cadence, render cost, substep evenness
node tools/profile.mjs      # per-view-module frame cost
node tools/smooth.mjs       # judder probe: how evenly the DRAWN world advances
```

In a dev build `window.__game` exposes `{ world, CFG, loop, renderer, scene, camera, views }`,
which is how those tools drive and measure the running game.

## Layout

| path | what lives there |
|---|---|
| `src/config.js` | **The** tuning table. Every gameplay number, and nothing else. |
| `src/curves.js` | The economy as pure functions. The harness imports this file, so the balance tables and the shipped game are provably the same code. |
| `src/core/` | `loop.js` (fixed 1/60 timestep, 3-substep ceiling, hitstop stack — the only `requestAnimationFrame` and the only place `dt` is scaled), `bus.js`, `input.js` |
| `src/sim/` | The simulation. Never imports three.js. `systems.js` is the tick order. `autopilot.js` is the lane policy the harness bot and the turret round's self-driving squad share. |
| `src/util/` | `pool.js` (the fixed-capacity pool, swap-remove and generation counter), `math.js`, `rng.js` — seeded, so the harness is reproducible. |
| `src/data/` | `weapons.js`, `enemies.js`, `encounters.js` — flat tables. A new enemy is one row plus a rig in `view/geometry.js`. |
| `src/view/`, `src/fx/` | Read-only observers of sim state. Instanced meshes, procedural geometry, the glyph atlas. `view/turret.js` is the mounted gun and its laser sight. |
| `src/ui/` | `hud.js` and `overlay.js` — the only DOM. |
| `src/audio/` | Every sound, synthesised. No files, and none may be added. |
| `src/reactions.js` | Where a sim event becomes presentation. "What happens when a barrel dies" is one function, and every bus subscription in the game lives here bar one — `main.js` owns the end-card hook. |
| `tools/` | Harness, sweep, bot, the five browser probes, and `chrome.mjs` (finds a Chrome to drive). |
| `CONTRIBUTING.md` | The invariants in enforceable form: what a reviewer checks, and the balance rule for a PR. |
| `docs/SPEC.md` | The design spec, with rationale per constant. The tuning table is current; the file manifest has drifted. The code wins. |
| `docs/VIEW_CONTRACT.md` | The palette, and exactly which sim fields the view may read. |

## Open work

Genuinely unfinished, roughly easiest first.

1. **The default dev port and the browser tools disagree.** All five tools default to
   `http://localhost:5180`; `vite.config.js` sets no `server.port`, so `npm run dev` serves
   5173 and every probe fails to connect until you remember `--port 5180`. Worse,
   `perf/profile/smooth` hardcode the URL outright — only `smoke/playthrough` read
   `GAME_URL`. Pin the port in `vite.config.js` and route all five through `GAME_URL`.
   (Browser *discovery* is already handled: `tools/chrome.mjs` resolves `$CHROME_PATH` or
   the platform's usual locations, so the tools are no longer macOS-only.)
2. **No npm script for the harness.** CI runs it on every push and gates on `firewall: OK`,
   so a broken firewall cannot merge — but locally the only way to check is to remember
   `node tools/harness.mjs`, and to run it from the repo root — it resolves `src/sim`
   against the working directory, so `cd tools && node harness.mjs` dies on ENOENT rather
   than saying so. An `npm run balance` script plus a `prebuild` hook would put the same
   guarantee CI gives in front of a local build.
3. **Pin three exactly.** `package.json` carries `^0.185.1`, but `view/props.js`,
   `view/characters.js` and `fx/particles.js` inject GLSL by string-replacing three's own
   shader chunks (`#include <color_fragment>` and friends). A patch bump that renames or
   reorders a chunk breaks those materials silently, with nothing in the console. Drop the
   caret.
4. **Docs that contradict the code.** `spawnGate` in `src/sim/props.js` says a gate "stays
   hp 0 so `rebuildTargets` skips it and bullets pass straight through" — but `targets.js`
   gives gates an explicit pass and `castRay` stops on them. The behaviour is right and
   intended; the comment is wrong, and in this codebase comments are load-bearing. Same job
   in `docs/SPEC.md`: reconcile the file manifest and the weapon table, or mark those
   sections historical.
5. **No debug overlay.** `systems.js` already exports a `disabled` Set that `runStep` honours
   by name, and nothing populates it. A panel that toggles systems and binds sliders to `CFG`
   turns bisecting a gameplay bug into a thirty-second job. This is the highest-value item
   on the list.
6. **The bot is no longer a good proxy for a human**, and this is why the gradient is
   non-monotone. `tools/bot.mjs` steers to the best gate segment and commits to it, but it
   never *shoots* a plate — gates are skipped outright in its target valuation
   (`bot.mjs:60`), even though whether a red plate can be flipped before it arrives is the
   exact cliff `gate.secondsPerStep` was tuned against. It also has no notion of a bloater's
   blast radius, so it never trades one early or steps clear. Until that is fixed the numbers
   in `config.js` are "plausible and playable", not "validated", and tuning further against
   this bot is fitting noise.
7. **Nobody has played this with a thumb on a real phone**, which is the only test that
   settles a drag game. `vite.config.js` sets `server.host = true` precisely so a phone on
   the LAN gets the dev build with live HMR.
8. **No `LICENSE` file yet.** `package.json` already declares `"license": "MIT"` under the
   new name, so the intent is recorded but the text nobody can rely on is missing — add the
   MIT text before this goes public.

Contributions are welcome — [`CONTRIBUTING.md`](CONTRIBUTING.md) has the rules in
reviewable form. The short version: if a change touches balance, include harness output
before and after; if it touches `src/sim`, keep the firewall green.

## Trademarks and attribution

Not affiliated with, endorsed by, or sponsored by Camel Games. *Age of Origins* is a
trademark of its respective owner and is referenced here only to describe, factually,
what genre of mode this project reimplements. This project copies none of that game's
expression — no art, audio, code, text, character names or logos — only the shape of a
well-known arcade format.

## License

MIT — see [LICENSE](LICENSE).
