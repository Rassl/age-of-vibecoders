/**
 * THE tuning table. Every gameplay number in the game lives here and nowhere else.
 *
 * ABSOLUTE CONVENTION: read values at the USE SITE (`CFG.squad.anchorTau`), never
 * destructure at module load. Destructuring freezes the value at boot and silently
 * defeats live retuning.
 */

export const FIXED_DT = 1 / 60

export const CFG = {
  // NG+ scalar. 1.0 is the authored baseline every table in this file is tuned
  // against. main.js raises it per completed round; curves.js applies it to
  // OBSTACLE pricing only (horde pressure, barrel/wall HP, boss HP) -- never to
  // rewards, safety caps, or the pre-boss lull's existence.
  difficulty: 1.0,

  world: {
    corridorWidth: 9.0,   // three readable 3u lanes
    railX: 4.5,
    clampX: 4.2,
    laneX: [-3.0, 0, 3.0],
    scrollStart: 14.0,
    scrollEnd: 18.0,
    spawnHorizon: 72,     // THE budget the whole economy is written against
    despawnZ: 12,
    runSeconds: 110,      // corridor length, before the boss
    squadZ: 0,            // the squad plane; everything scrolls toward it
  },

  sim: {
    fixedDt: FIXED_DT,
    maxSubsteps: 3,
    dtClamp: 0.05,        // a backgrounded tab returns a multi-second delta
  },

  input: {
    dragScreenFraction: 0.55, // of screen width to cross the whole corridor
    maxTravelPx: 300,         // ...but never more than this much physical travel
    lowPassTau: 0.045,        // digitizer jitter only -- never feel
    // The flat speed the squad travels at for the whole middle of any move. The
    // 8.4u corridor takes ~0.8s to cross, so a lane change reads as travel.
    cruiseSpeed: 10.5,
    accel: 75,                // u/s^2 -- reaches cruise in ~0.14s
    decel: 130,               // harsher, so releasing does not coast like ice
    arriveTime: 0.07,         // proportional band at the end of a pointer move
  },

  squad: {
    startCount: 3,
    // Effectively unlimited: no run can earn this many under the reward
    // economy, so growth never hits the ceiling. It stays finite because the
    // instanced GPU buffers in view/characters.js are sized from pool.soldiers
    // at boot -- maxCount must never exceed that.
    maxCount: 250,
    // Audio/haptics "full crowd" reference. Was maxCount when maxCount was 40;
    // pinned here so an uncapped squad does not flatten the intensity curve.
    intensityRef: 40,
    anchorTau: 0.06,
    soldierRadius: 0.18,
    iframeSeconds: 0.70,
  },

  formation: {
    spacingBase: 0.42,
    densityExp: 0.18,
    densityRef: 18,
    densityMin: 0.62,
    phi: 2.39996,        // golden angle -- phyllotaxis
    squashX: 0.75,
    squashZ: 1.35,
    maxRadius: 2.1,
    followTauFront: 0.09,
    followTauBack: 0.20,
    // Against a smooth velocity now, so it can be PROPORTIONAL: the squad leans
    // by how fast it is travelling instead of snapping to full tilt the instant
    // it moves at all. Saturates near cruise, which is where it should.
    leanGain: 0.055,
    slotJitter: 0.06,
  },

  weapons: {
    // Per-tier stats live in data/weapons.js, which is the single source; only
    // the scalar that every tier multiplies lives here.
    baseDps: 10,          // squad DPS reads as soldiers * 10 * WEAPONS[tier].dpsMult
    startTier: 0,         // start on the pistol so progression is felt immediately
    visibleShooters: 14,  // cosmetic tracer cap; damage stays exactly linear
    firePhaseStagger: 0.618,
    tracerThinCount: 20,
    tracerThin: 0.06,
    tracerThick: 0.11,
  },

  combat: {
    impactDelay: 0.0,     // 0 == pure hitscan. Tune toward 0.08 with the replay tape.
    tracerSpeed: 220,
    displayHpLerpHz: 8,
    // Rays are given a width so that the hitbox for DEALING damage is never
    // smaller than the hitbox for TAKING it. Without this a zombie can sit
    // 0.4u from a soldier -- close enough to kill it, too far to be hit by it --
    // which players correctly read as "they walked straight through my bullets".
    bulletRadius: 0.22,
    ledgerSize: 256,
  },

  curves: {
    parSquadBase: 3,
    parSquadRate: 0.132,
    // Rebased for a 5-tier ladder starting at 1.0x: par reaches ~3.0x by the
    // boss gate, i.e. the median player banks roughly three of the four upgrades.
    parWeaponBase: 1.0,
    parWeaponDouble: 40,   // seconds per 1.5x
  },

  barrel: {
    // fraction of the engagement window a role is meant to consume at par DPS
    alpha: { bubble: 0.16, cheap: 0.35, wall: 0.58, toll: 0.66 },
    // asymmetric blend toward the player's ACTUAL dps: mandatory content follows you
    // lambdaUp = 1.0 makes TTK exactly DPS-INVARIANT: the toll always costs the
    // same SECONDS no matter how strong you are, so the opportunity cost of the
    // greedy lane never decays. Mandatory content (wall) blends below 1.0 so it
    // gets genuinely easier as you grow and nobody is ever walled out.
    lambdaDown: { bubble: 0.60, cheap: 0.38, wall: 0.62, toll: 0.30 },
    lambdaUp: { bubble: 1.00, cheap: 0.95, wall: 0.80, toll: 1.00 },
    scaleClamp: [0.4, 3.0],
    breachF: { wall: 0.60, cheap: 0.35, toll: 0.35 },
    breachExp: 1.5,       // near-kills are nearly free; ignoring one is brutal
    breachCapFrac: 0.6,   // no single event wipes a squad
    dodgeableWidth: 3.2,
    wallWidth: 9.0,
    dodgeTestRadius: 0.6, // FIXED -- never the crowd's real width
    height: 2.5,
    radius: 0.95,
  },

  bubble: {
    radius: 0.7,
    y: 1.1,
    perBubbleBase: 2,
    perBubbleRate: 0.052,
    perBubbleMax: 8,
    missPenalty: 0,       // never punish a miss
    joinerSpeed: 16,
    joinerStagger: 0.06,
    maxTier: 4,
  },

  zombie: {
    walkerHpBase: 8,
    hpDouble: 45,         // seconds per 1.5x -- crowds get bigger, not tankier
    lateralHoming: 2.5,
    // Per-kind speed/radius/kills/hpMult live in data/enemies.js.
    spitSpeed: 15,        // acid projectile
    spitRadius: 1.25,     // how close it has to land to take a soldier
    spitKills: 1,
  },

  threat: {
    betaBase: 0.104,
    betaRate: 0.0013,
    waves: [[26, 0.15], [46, 0.18], [62, 0.21], [84, 0.27], [100, 0.55]],
    waveRise: 2.0, waveHold: 2.0, waveFall: 3.0,
    crescendo: { from: 96, to: 101, peakBeta: 1.18, sweeps: [97, 100, 103] },
    lullFrom: 101, lullBeta: 0.10,
    spawnCap: 44,
    clusterSpread: 2.6,
    clusterWidth: 1.5,
    // Pre-banked spawn credit at run start: two clusters walk in on the very
    // first director tick. Without it the demand curve (beta * dps / hp) needs
    // ~10s to bank its first cluster and the opening reads as an empty road --
    // the first bodies should be visible before the first barrel decision.
    startCredit: 8,
  },

  // HOLDOUT mode (even NG+ rounds): the squad stands its ground and the horde
  // walks in. No gates/barrels/bubbles -- reinforcements and tier-ups arrive on
  // the par curves instead, so the boss-gate economy stays intact.
  holdout: {
    // Nearer than the 72u advance horizon: bodies close at leg speed (~5-16
    // u/s boosted) instead of leg+scroll (~20u/s), and spawning at 72 would
    // leave the road empty for the first ten seconds.
    spawnHorizon: 46,
    // Multiplies each kind's own speed so pressure at the squad stays close to
    // advance mode without the treadmill's contribution.
    speedMult: 1.8,
    // How fast barrels, gates and bubbles close on the planted squad. Near the
    // boosted walker's pace, so the hazard wall arrives WITH its crowd; the
    // ~6.6s horizon-to-squad window is roomier than advance's 4.5s, which is
    // the intended slack for a mode where you cannot outrun anything.
    propSpeed: 11.5,
    // Baseline bodies/s, ramping with t -- the stand-in for the pressure the
    // treadmill's closing speed used to add on top of the leg-speed approach.
    crowdMult: 1.0,
    baseRate: 0.4,
    baseRateRamp: 0.04,
  },

  // TURRET mode (every third round): the player crews a mounted gun on the
  // truck behind the squad and AIMS it with the drag; the squad steers itself
  // (sim/autopilot.js runs the harness bot's lane policy in-sim) and fires as
  // always. The turret's ray is the one shot in the game that does NOT go
  // straight down -Z: it leaves the muzzle at the gun's yaw, so the player can
  // pick a barrel, a bubble, a spitter or a bloater in any lane.
  turret: {
    z: 8.2,               // the yaw pivot, behind the squad plane, in front of the camera
    barrelLen: 2.0,       // pivot to muzzle; the ray and the flash leave from here
    muzzleY: 1.62,
    // The truck the gun is mounted on follows the squad across the corridor,
    // PARTIALLY and with a vehicle's lag, so the camera behind it keeps the
    // squad in a portrait frame whose horizontal field is only ~35 degrees.
    // Pinned at x = 0 the squad slid off the edge every time the pilot took
    // an outer lane. The aim point is absolute on the aim plane, so following
    // moves the gun's yaw, never the beam's landing spot.
    follow: 0.70,
    followTau: 0.35,
    // The reticle lives on a plane far down the road. The drag moves it across
    // that plane, so the gun's yaw is atan(aim / (z - aimZ)) and one corridor
    // width of finger travel sweeps the whole road at the distance the player
    // is actually reading. Clamp is wider than the rails so the outer lanes
    // can be raked from the near side.
    aimZ: -40,
    aimClampX: 5.6,
    aimSpeed: 30,         // u/s at the aim plane under a held key
    aimTau: 0.05,         // digitizer jitter only, never feel
    // Priced against PAR dps, exactly like a drone: a fixed slice of the run's
    // difficulty curve whether the squad is ahead of it or behind. Barrels are
    // still priced against the squad's own nominalDPS, so the turret is pure
    // surplus -- which is what lets a poor squad-pilot round still be won by
    // good aim.
    //
    // Measured headless with a PERFECT-aim policy (reticle always on the
    // nearest prop) at the mode's natural slot, round 3 (difficulty 1.30),
    // three seeds: 0.75 -> 20/20 bubbles, peak ~120, the pair beat deleted;
    // 0.50 -> 3/3 wins, 10/20 bubbles, peak 40-57, 2-4 breaches; 0.35 ->
    // 3/6 wins; 0.25 -> 3/6. A flawless gunner should clear it with room and
    // still have to choose lanes, so 0.50. At round 1 (difficulty 1.0, only
    // reachable via ?mode=turret) the same policy peaks ~100: expected.
    dpsFrac: 0.50,
    rate: 12,
    pierce: 1,
    spread: 0.30,         // lateral jitter at the aim plane
    // The self-driving squad's skill, in the bot's own aim-efficiency units:
    // 0.82 sits between the harness's GOOD and COMPETENT tiers. The reaction
    // cadence is the bot's too. Both live here rather than in the bot so a
    // balance pass can retune the squad without touching tools/.
    squadAim: 0.82,
    squadReact: 0.20,
    // High and close, pitched ~27 degrees: the horizon sits in the top tenth
    // of the frame, the squad just below centre, and the barrel cluster rises
    // out of the bottom edge with the receiver cropped -- the gun is FELT as
    // the thing under the camera, not shown as a model. A lower camera shows
    // LESS gun, not more, because the whole gun then sits under the frame.
    camera: {
      pos: [0, 6.6, 11.5],
      lookY: 0.9,
      lookZ: 1.0,
      lookXFactor: 0.12,  // of the aim, so the world pans under the gun
      posXFactor: 0.10,
      fov: 66,
    },
  },

  boss: {
    hpPar: 0.55, hpActual: 0.45, hpTau: 14,
    hpMin: 4600, hpMax: 14400,
    plates: [1.0, 0.66, 0.33],
    plateStagger: 1.2,
    slamPeriod: 3.5,
    ragePeriod: 2.0,
    rageTimer: 30,
    addPeriod: 2.5,
    height: 9.5,
    radius: 3.2,
    entryDecel: 1.6,
    spawnZ: -60,
    standZ: -15,
    contactKillPeriod: 0.5,
    shockSpeed: 22,
    // Must exceed the crowd's own width (3.15u at 40 soldiers) or `inGap` is
    // unsatisfiable and every slam is an unavoidable 2-soldier tax -- which
    // would punish exactly the growth the whole run is about.
    shockGap: 4.6,
    shockKills: 2,
    // Served from public/. Relative (no leading slash) because vite base is
    // './'. If the fetch 404s the boss keeps its procedural ball head.
    headModelUrl: 'models/boss-head.glb',
  },

  camera: {
    basePos: [0, 8.0, 16.5],
    lookY: 0.8,
    lookZ: -10.0,
    lookXFactor: 0.25,
    lookVelFactor: 0.06,
    fov: 38,
    near: 1,
    far: 200,
    followFactor: 0.50,   // partial -- 1:1 makes the drag read as dead
    followTau: 0.20,
    rollGain: 0.012,
    dollyGain: 1.15,
    dollyMaxZ: 19.5,
    dollyOmega: 3.0,
    fovSpeedKick: 3.5,
    traumaDecay: 1.6,
    trauma: {
      soldierLoss: 0.35, barrelDead: 0.30, bossFootfall: 0.22,
      bossSlam: 0.45, bubbleShatter: 0.10, bossDeath: 1.0, kill: 0.0,
    },
    shakeYaw: 0.0157, shakePitch: 0.0157, shakeRoll: 0.0244, shakePos: 0.10,
  },

  fx: {
    hitstopBarrel: [0.05, 0.070, 0.060],   // [timescale, hold, ramp]
    hitstopBossDeath: [0.02, 0.180, 0.120],
    hitFlashDecay: 8.0,
    damageAggregation: 0.180,
    muzzleLife: 0.055,
    ringRadius: { soldier: 0.34, zombie: 0.36, brute: 0.52, boss: 3.2 },
    fogDensity: 0.0048,
    recoilOmega: 26, recoilZeta: 0.5,
  },

  perf: {
    pixelRatioDesktop: 2.0,
    pixelRatioMobile: 1.5,
    dprDownshiftMs: 20,
    dprDownshiftFrames: 30,
  },

  // Gates: the steering decision, as opposed to the barrel's shooting decision.
  // A row of segments spans the corridor and you pass through EXACTLY ONE, so
  // the choice is which value to take, never whether to engage at all.
  gate: {
    height: 1.45,
    y: 0.0,
    postHalf: 0.11,
    thickness: 0.16,
    // Gate rows are authored as fractions of the corridor and sized here, so a
    // row always tiles the full width with no gap for the squad to slip through
    // un-taxed and no overlap that could bill it twice.
    rowInset: 0.06,
    // Same guarantee the barrel breach cap makes: no single event wipes a squad
    // of >= 2. Without it a -4 row meeting a squad of 4 is an instant loss with
    // no counterplay, which is not a decision, it is a coin flip.
    //
    // Raised 0.5 -> 0.7 when the cap moved from resolution time to SPAWN time.
    // A plate is now priced against the squad that exists when it appears, and
    // the squad usually GROWS during the ~2s approach, so the same fraction bit
    // less hard than before: 24/30 in the harness against a 20-21/30 baseline.
    // 0.7 restores it to 21/30.
    lossCapFrac: 0.70,
    // Shooting a plate walks its number UP -- a blue gate pays more, a red one
    // hurts less and will flip to blue if you pour enough into it.
    //
    // The threshold is priced in SECONDS OF THE SQUAD'S OWN DPS, not in flat
    // damage, so a plate climbs at the same ~3.3 points/second for a 3-soldier
    // pistol squad and a 40-soldier minigun squad. A flat threshold would make
    // gates trivial content by the back half of the run.
    //
    // There is a CLIFF just above this value. At 0.30-0.32 a red plate can be
    // flipped before it arrives and the run scores 20/30 in the harness, the
    // same as before gates existed. By 0.38 it cannot, so the DPS is spent AND
    // the penalty still lands: 12/30, with weapon tier down at 1-2. Do not
    // raise this without re-running tools/harness.mjs.
    // Gate rows spawn MUCH closer than the 72u content horizon.
    //
    // A plate stops bullets, so while a row is in the firing line the squad's
    // whole output goes into it and nothing else is being shot. That trade is
    // the mechanic, but across a 72u approach it is a five-second fire blackout
    // eight times a run, which the horde simply walks through. At 34u the
    // blackout is about two seconds: long enough to be a real decision, short
    // enough to survive.
    spawnZ: -34,
    secondsPerStep: 0.30,
    maxValue: 25,
    joinerStagger: 0.05,
    // Width tug-of-war (growGate): how fast a segment under FULL squad fire
    // steals width from its neighbours, in u/s -- and the floor no panel is
    // ever squeezed below, so its number stays printable and its bill visible.
    tugPerSec: 1.1,
    minHalfW: 0.55,
  },

  /**
   * Escort drones -- the "additional helper" pickup.
   *
   * The drone is the DELIBERATE EXCEPTION to "bullets go straight and you aim
   * with your body". It targets off-axis and lobs a travelling bolt, so it
   * answers the one threat body-aiming cannot: something alive in a lane you
   * are not standing in. That is also why it is strictly TIMED -- a permanent
   * off-axis turret would quietly retire the mode's whole premise.
   */
  drone: {
    // No default escort: the drone is a PICKUP, earned from its bubble. (It
    // once deployed with the squad to fix a discoverability complaint -- "I
    // don't see it" -- so if drone bubbles ever move back behind expensive
    // tolls, revisit this: a mechanic the player cannot discover is not a
    // mechanic.)
    startCount: 0,
    // Room for every pickup a run can realistically hold at once; sized when a
    // permanent default escort occupied one slot, and left alone so stacking
    // drone bubbles stays rewarding.
    maxActive: 3,
    // A TIMED pickup cannot be balanced against a permanent one at short
    // duration. A soldiers bubble pays ~6 bodies that then fight for the rest of
    // the run -- about 11,000 damage. A 14s drone at 0.20 par delivered 870, a
    // 13x shortfall, and it measured 0.7-2.1% of a run's damage: decoration.
    // Long enough to matter, still short enough that the off-axis exception is
    // an interlude rather than the new normal.
    lifetime: 38,
    // Only meaningful while startCount > 0: a default escort, if one ships,
    // never expires -- one that vanishes 38s in reproduces the discoverability
    // complaint it existed to fix. Pickup drones stay timed regardless.
    startPermanent: true,
    // Priced against PAR dps, not the squad's actual dps, so a drone is worth a
    // known, fixed slice of the run's difficulty curve whether the player is
    // ahead of it or behind. Scaling off actual dps would pay the strongest
    // squads the most, which is backwards for a catch-up pickup.
    //
    // The exact value matters far less than it looks: with the drone shooting
    // BARRELS as well as bodies, 0.55 through 1.50 all land at 20-21/30 in the
    // harness. What the drone shoots decided the balance; how hard it hits did
    // not. Kept low-middle so it helps without trivialising a beat.
    dpsFrac: 0.75,
    // The DEFAULT escort is far weaker than a bought one, and it has to be.
    // Measured, wins out of 30 in tools/harness.mjs against a 20/30 pre-drone
    // baseline: 0.03 -> 20, 0.05 -> 22, 0.07 -> 27, 0.10 -> 24, 0.22 -> 30/30
    // with every tier pinned at the squad cap. It is a scout that plinks; the
    // drones bought behind tolls at 0.75 are the actual power spike.
    // dpsFrac is relative to PAR, and the squad opens at 3 soldiers -- which is
    // par -- so a starting drone at 0.75 par is ~75% of the squad's own output
    // in exactly the stretch where runs are actually lost. At parity with pickup
    // drones every skill tier won 5/5 and finished at the 40 cap.
    startDpsFrac: 0.05,
    fireRate: 2.2,
    // Zombies spawn at the 72u horizon and are usually dead long before they
    // close, so a short range means the drone simply never finds a target:
    // measured 0 in-range bodies while 4 stood in front of it at 30u.
    range: 55,
    // How far a barrel outranks a body at the same distance, in world units of
    // effective closeness. Barrels are what breach, so they get priority.
    barrelBias: 16,
    blastRadius: 1.7,
    // A bolt also detonates on proximity in flight, at this fraction of the
    // blast radius, so an imperfect lead still reads as a hit.
    proximityFrac: 0.75,
    // Pose: orbits the squad anchor so two drones never occlude each other.
    height: 3.1,
    orbitRadius: 2.5,
    orbitHz: 0.20,
    bobAmp: 0.20,
    bobHz: 0.85,
    followTau: 0.16,
    // Fast, deliberately. At 30u/s a bolt spent ~1s in flight and the squad's
    // own fire routinely killed the target before it landed -- measured 0.33
    // bodies caught per burst. Flight time is the whole problem, so shorten it.
    boltSpeed: 58,
    homingTau: 0.10,
    boltLife: 2.0,
  },

  pool: {
    soldiers: 256, joiners: 48, zombies: 220, props: 12, shockwaves: 12,
    impacts: 256, tracers: 256, muzzle: 32, particles: 4096, glyphs: 96, spits: 48,
    decals: 64, rings: 512, eventRing: 2048, chunks: 48,
    drones: 4, bolts: 48,
  },

  // Filled by deriveConfig() at boot and on every resize.
  derived: {
    dragGain: 0.038,
    canvasCssW: 430,
    canvasCssH: 900,
    isMobile: false,
  },
}

/**
 * Recompute everything that depends on canvas size. Called at boot and on resize
 * so that corridor width and drag feel cannot drift apart.
 */
export function deriveConfig(canvasCssW, canvasCssH) {
  const d = CFG.derived
  d.canvasCssW = canvasCssW
  d.canvasCssH = canvasCssH
  // Crossing the corridor should cost the same PHYSICAL travel everywhere. A raw
  // fraction-of-width rule is fine on a 430px phone but means over 1000px of
  // mouse travel in a desktop window, which is what makes the steering feel dead.
  const travelPx = Math.min(CFG.input.dragScreenFraction * canvasCssW, CFG.input.maxTravelPx)
  d.dragGain = CFG.world.corridorWidth / travelPx
  d.isMobile = matchMediaSafe('(pointer: coarse)')
  return CFG
}

function matchMediaSafe(q) {
  try {
    return typeof matchMedia === 'function' && matchMedia(q).matches
  } catch {
    return false
  }
}

/** Walk every leaf and throw on a non-finite number. The no-TypeScript safety net. */
export function validateConfig(node = CFG, path = 'CFG') {
  for (const k of Object.keys(node)) {
    const v = node[k]
    const p = `${path}.${k}`
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`config: ${p} is not finite (${v})`)
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`config: ${p}[${i}] is not finite`)
      })
    } else if (v && typeof v === 'object') {
      validateConfig(v, p)
    }
  }
  return true
}
