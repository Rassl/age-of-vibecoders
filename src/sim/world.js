/**
 * All simulation state, in pre-allocated pools.
 *
 * NOTHING under src/sim/ may import three.js. tools/harness.mjs asserts this in
 * bare node, which buys headless balance runs, deterministic replay, and a hard
 * answer to "is this a sim bug or a render bug".
 *
 * Entities are plain objects with a fixed monomorphic shape, never
 * struct-of-arrays: at n <= 220 the whole sim is ~1.5ms, and a debugger showing
 * {x: 2.1, hp: 40, kind: 'walker'} is worth more than the microseconds.
 *
 * DEATH IS TWO-PHASE: systems set `dead = true`, and a single reap pass releases.
 * Three systems marking the same zombie in one substep is then idempotent, and
 * nothing is swap-removed out from under an in-progress iteration.
 */
import { CFG } from '../config.js'
import { Pool } from '../util/pool.js'
import { Rng } from '../util/rng.js'

let nextId = 1

export const STATE = { READY: 0, RUNNING: 1, BOSS: 2, WON: 3, LOST: 4 }

/**
 * Run modes. ADVANCE is the original lane-runner: the world treadmills past a
 * marching squad. HOLDOUT plants the squad: scroll is zero, the road stands
 * still, and the horde closes the distance on its own legs -- the director
 * swaps the gate/barrel economy for timed reinforcements (director.js).
 * TURRET keeps the treadmill but hands the drag to a mounted gun behind the
 * squad; the squad steers itself (autopilot.js) and the player aims.
 */
export const MODE = { ADVANCE: 0, HOLDOUT: 1, TURRET: 2 }

function makeSoldier() {
  return {
    id: nextId++, gen: 0, dead: false,
    slot: 0, x: 0, z: 0, slotX: 0, slotZ: 0,
    fireTimer: 0, iframe: 0, recoil: 0, recoilVel: 0,
    // view-only springs live here so the view never allocates per soldier
    vx: 0, vz: 0, lean: 0, phase: 0, scale: 1, jitterX: 0, jitterZ: 0,
  }
}

function makeJoiner() {
  return { id: nextId++, gen: 0, dead: false, x: 0, y: 0, z: 0, delay: 0, t: 0, sx: 0, sz: 0 }
}

function makeZombie() {
  return {
    id: nextId++, gen: 0, dead: false, kind: 'walker',
    x: 0, z: 0, hp: 0, maxHp: 0, speed: 0, radius: 0.3, kills: 1,
    scale: 1, cadence: 2, phase: 0, flash: 0, spawnT: 0, pending: 0, touched: false,
    killedByPlayer: false,
    // ranged (spitter): holds at a standoff distance, winds up, fires, reloads.
    ranged: false, holding: false, windup: 0, reload: 0, aimX: 0,
    // volatile (bloater): its death blast is resolved once, in the reap pass.
    explodes: false, blasted: false,
  }
}

/** Acid projectile thrown by a spitter. */
function makeSpit() {
  return { id: nextId++, gen: 0, dead: false, x: 0, y: 1.2, z: 0, vz: 0, t: 0, landed: false }
}

function makeProp() {
  return {
    id: nextId++, gen: 0, dead: false, kind: 'barrel', role: 'cheap',
    x: 0, z: 0, hp: 0, maxHp: 0, displayHp: 0, halfW: 1.6,
    flash: 0, pending: 0, touched: false, resolved: false,
    reward: null, gate: null, gatedBy: null, beatT: 0, killedByPlayer: false,
    value: 0, charge: 0,
  }
}

function makeDrone() {
  return {
    id: nextId++, gen: 0, dead: false, touched: false, pending: 0,
    x: 0, y: 0, z: 0, life: 0, maxLife: 0, phase: 0, fireTimer: 0, slot: 0,
    permanent: false, dpsFrac: 0,
    aimX: 0, aimZ: 0, hasTarget: false,
  }
}

function makeBolt() {
  return {
    id: nextId++, gen: 0, dead: false, touched: false, pending: 0,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, tz: 0, life: 0, damage: 0,
    tref: null, tgen: 0,
  }
}

function makeShockwave() {
  return { id: nextId++, gen: 0, dead: false, z: 0, gapX: 0, gapW: 2.2, life: 0, hit: false }
}

function makeImpact() {
  return { target: null, gen: 0, damage: 0, due: 0, x: 0, y: 0, z: 0 }
}

export function createWorld(seed = 1337) {
  const p = CFG.pool
  return {
    // --- run scalars ---
    state: STATE.READY,
    mode: MODE.ADVANCE,
    runTime: 0,
    distance: 0,
    scroll: CFG.world.scrollStart,
    scrollTarget: CFG.world.scrollStart,
    seed,
    rng: new Rng(seed),

    // --- steering ---
    targetXRaw: 0,
    targetXSmooth: 0,
    anchorX: 0,
    anchorVelX: 0,
    keySteer: false,
    // Seeded so render interpolation is valid on the very first frame, before
    // any step has run (the world sits in READY behind the start card).
    prevAnchorX: 0,
    prevDistance: 0,

    // --- turret (MODE.TURRET) ---
    // The reticle's x on the CFG.turret.aimZ plane: raw is where the finger put
    // it, smooth is what the gun tracks. yaw is derived from smooth each step
    // and read by both the ray cast and the view, so they can never disagree.
    turretAimRaw: 0,
    turretAim: 0,
    // The truck's x: a lagged partial follow of the squad (steer.js).
    turretX: 0,
    turretYaw: 0,
    turretFireTimer: 0,
    turretShots: 0,
    // Where the last turret ray stopped; the laser sight is drawn to it.
    turretHitX: 0,
    turretHitZ: 0,
    // The self-driving squad's lane memory (autopilot.js). Same shape as the
    // harness bot's memo so the two share one policy.
    auto: { cooldown: 0, target: 0, rowId: -1, x: 0 },

    // --- squad ---
    count: 0,
    tier: CFG.weapons.startTier,
    nominalDPS: 0,
    pendingAdds: 0,
    pendingRemoves: 0,
    lossCause: 0,
    formationDirty: true,
    // Wings pickup: seconds of flight left, and the smoothed 0..1 altitude the
    // view and the muzzle heights read (sim/wings.js).
    wings: 0,
    altitude: 0,

    // --- run stats, for the end screen ---
    stats: {
      kills: 0, barrelsKilled: 0, barrelsBreached: 0, bubblesTaken: 0,
      bubblesMissed: 0, soldiersGained: 0, soldiersLost: 0, peakCount: 0,
      damageDealt: 0, tierUps: 0, gatesTaken: 0, gatesEaten: 0, dronesTaken: 0,
      droneDamage: 0, droneBursts: 0, droneHits: 0, wingsTaken: 0,
    },

    // --- pools ---
    soldiers: new Pool(p.soldiers, makeSoldier),
    joiners: new Pool(p.joiners, makeJoiner),
    zombies: new Pool(p.zombies, makeZombie),
    props: new Pool(p.props, makeProp),
    shockwaves: new Pool(p.shockwaves, makeShockwave),
    impacts: new Pool(p.impacts, makeImpact),
    spits: new Pool(p.spits, makeSpit),
    drones: new Pool(p.drones, makeDrone),
    bolts: new Pool(p.bolts, makeBolt),

    // --- combat scratch (pre-allocated, never grows) ---
    blockers: newBlockerArray(p.zombies + p.props + 2),
    blockerCount: 0,
    lastHitZ: 0,
    touched: new Array(p.zombies + p.props + 2).fill(null),
    touchedCount: 0,
    impactsDiscarded: 0,

    // --- boss ---
    boss: {
      active: false, dead: false, x: 0, z: CFG.boss.spawnZ, hp: 0, maxHp: 0,
      gen: 0, plateIndex: 0, stagger: 0, slamTimer: 0, addTimer: 0,
      rage: 0, raging: false, phase: 0, flash: 0, contactTimer: 0,
      pending: 0, touched: false, entryT: 0,
    },

    // --- director ---
    beatCursor: 0,
    gateCursor: 0,
    sweepCursor: 0,
    spawnCredit: 0,
    lastBeatT: -1,
  }
}

function newBlockerArray(n) {
  const a = new Array(n)
  for (let i = 0; i < n; i++) a[i] = { ref: null, x: 0, z: 0, half: 0, kind: 0 }
  return a
}

/**
 * Restart with zero allocation and no scene teardown: every pool size goes to 0,
 * the beat cursor rewinds, scalars reset. One frame, well under 5ms.
 * If a restart ever needs to touch the scene graph, the pooling is wrong.
 */
export function resetWorld(w, seed = w.seed) {
  w.state = STATE.RUNNING
  w.runTime = 0
  w.distance = 0
  w.scroll = CFG.world.scrollStart
  w.scrollTarget = CFG.world.scrollStart
  w.seed = seed
  w.rng.seed = seed >>> 0

  w.targetXRaw = 0
  w.targetXSmooth = 0
  w.anchorX = 0
  w.anchorVelX = 0
  w.keySteer = false
  w.prevAnchorX = 0
  w.prevDistance = 0

  w.turretAimRaw = 0
  w.turretAim = 0
  w.turretX = 0
  w.turretYaw = 0
  w.turretFireTimer = 0
  w.turretShots = 0
  w.turretHitX = 0
  w.turretHitZ = -CFG.world.spawnHorizon
  w.auto.cooldown = 0
  w.auto.target = 0
  w.auto.rowId = -1
  w.auto.x = 0

  w.count = 0
  w.tier = CFG.weapons.startTier
  w.nominalDPS = 0
  w.pendingAdds = 0
  w.pendingRemoves = 0
  w.lossCause = 0
  w.formationDirty = true
  w.wings = 0
  w.altitude = 0

  for (const k of Object.keys(w.stats)) w.stats[k] = 0

  w.soldiers.clear()
  w.joiners.clear()
  w.zombies.clear()
  w.props.clear()
  w.shockwaves.clear()
  w.impacts.clear()
  w.spits.clear()
  w.drones.clear()
  w.bolts.clear()

  w.blockerCount = 0
  w.lastHitZ = 0
  w.touchedCount = 0
  w.impactsDiscarded = 0

  const b = w.boss
  b.active = false; b.dead = false; b.x = 0; b.z = CFG.boss.spawnZ
  b.hp = 0; b.maxHp = 0; b.plateIndex = 0; b.stagger = 0
  b.slamTimer = 0; b.addTimer = 0; b.rage = 0; b.raging = false
  b.phase = 0; b.flash = 0; b.contactTimer = 0; b.pending = 0
  b.touched = false; b.entryT = 0; b.gen++

  w.beatCursor = 0
  w.gateCursor = 0
  w.sweepCursor = 0
  w.spawnCredit = CFG.threat.startCredit
  w.lastBeatT = -1
  return w
}
