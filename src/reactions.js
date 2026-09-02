/**
 * Every consequence of every event, in one file.
 *
 * The sim emits FACTS ("a barrel died at x,z"); this is the only place that
 * decides what a fact LOOKS and SOUNDS like. Keeping it here is what makes
 * "what happens when a barrel dies" a single readable function instead of a
 * behaviour scattered across nine systems.
 *
 * Nothing here may write sim state.
 */
import { CFG } from './config.js'
import { bus, T } from './core/bus.js'
import { CAUSE } from './sim/roster.js'
import { TURRET_TIER } from './data/weapons.js'

export function wireReactions({ loop, camera, particles, tracers, rings, hud, audio, world, blasts, turret }) {
  const trauma = CFG.camera.trauma

  // ---- shooting: four feedback channels on every hit, no exceptions ----------

  bus.on(T.MUZZLE, (e) => {
    // kind is 0 for every soldier (the tier comes from the last sync) and
    // TURRET_TIER for the mounted gun, which has its own flash and no brass.
    const fromTurret = e.kind === TURRET_TIER
    tracers.spawnMuzzle(e.x, e.y, e.z, fromTurret ? TURRET_TIER : undefined)
    if (fromTurret && turret) turret.kick()
  })

  bus.on(T.TRACER, (e) => {
    // e.c is the rake: lateral drift per unit of travel, 0 for the squad.
    tracers.spawnTracer(e.x, e.y, e.z, e.a, e.kind, e.c)
    audio.shot(e.kind, e.x)
  })

  bus.on(T.HIT, (e) => {
    // e.kind is the blocker kind, so flesh, metal and glass each get their own
    // impact character -- and this is where the damage number comes from.
    blasts.impact(e.x, e.y, e.z, e.kind, e.a)
  })

  bus.on(T.KILL, (e) => {
    // Dark, desaturated: blood must not compete with the barrel reds, which are
    // the only reds in the scene that carry gameplay meaning.
    blasts.kill(e.x, e.z)
    // Explicitly NO trauma on an ordinary kill. If everything shakes, nothing does.
  })

  // ---- barrels --------------------------------------------------------------

  bus.on(T.BARREL_DEAD, (e) => {
    const [scale, hold, ramp] = CFG.fx.hitstopBarrel
    loop.punch(scale, hold, ramp)
    camera.addTrauma(trauma.barrelDead)
    camera.punchFov(-2.5)
    blasts.barrel(e.x, e.z, e.kind === 1 ? 1.5 : 1.0)
    audio.explosion(e.x)
  })

  bus.on(T.BARREL_BREACH, (e) => {
    // e.a = soldiers lost, e.b = fraction of HP left when it hit
    camera.addTrauma(trauma.soldierLoss + 0.2 * e.b)
    blasts.breach(e.x, e.z)
    audio.explosion(e.x)
  })

  bus.on(T.BARREL_DODGED, (e) => {
    particles.burst('dust', e.x, 0.2, e.z, 6)
  })

  // ---- bubbles: the best half-second in the mode -----------------------------

  bus.on(T.BUBBLE_BREAK, (e) => {
    camera.addTrauma(trauma.bubbleShatter)
    blasts.bubble(e.x, e.y, e.z)
    audio.bubbleBreak(e.x)
  })

  bus.on(T.BUBBLE_MISS, (e) => {
    particles.burst('smoke', e.x, e.y, e.z, 4)
  })

  bus.on(T.SOLDIER_GAIN, (e) => {
    particles.burst('spark', e.x, 0.4, e.z, 10)
    audio.pickup(e.x)
  })

  bus.on(T.WEAPON_UP, (e) => {
    camera.punchFov(-3.5)
    particles.burst('spark', e.x, e.y, 0, 24)
    audio.pickup(e.x)
  })

  // ---- losses: escalate to a screen-level event ------------------------------
  //
  // Losing 1 of 40 soldiers is 2.5% of the crowd and is otherwise completely
  // invisible. Without this stack players never learn what killed them.

  bus.on(T.SOLDIER_LOSS, (e) => {
    rings.addDeathRing(e.x, e.z)
    particles.burst('blood', e.x, 0.8, e.z, 6)
  })

  bus.on(T.COUNT_CHANGED, (e) => {
    const delta = e.a
    const count = e.b
    hud.pulseCount(delta)
    if (delta >= 0) return
    const lost = -delta
    const before = count + lost
    camera.addTrauma(trauma.soldierLoss * Math.min(1, lost / 3))
    hud.flashDamage(before > 0 ? lost / before : 1)
    audio.loss(e.x)
    if (e.kind === CAUSE.ZOMBIE || e.kind === CAUSE.BREACH) vibrate(20)
  })

  // ---- ranged and volatile enemies -------------------------------------------
  //
  // The spitter is the only threat that cannot be answered by moving out of the
  // way after the fact, so its windup MUST be loud and early -- the whole
  // mechanic is the second and a half of warning it gives you.

  bus.on(T.SPIT_WINDUP, (e) => {
    blasts.spitWindup(e.x, e.y, e.z)
    audio.impact(e.x)
  })

  bus.on(T.SPIT_FIRE, (e) => {
    blasts.spitFire(e.x, e.y, e.z)
    audio.bubbleBreak(e.x)
  })

  bus.on(T.SPIT_LAND, (e) => {
    const hit = e.a === 1
    blasts.spitLand(e.x, e.z, hit)
    if (hit) camera.addTrauma(trauma.soldierLoss * 0.6)
    audio.impact(e.x)
  })

  // ---- escort drones ---------------------------------------------------------

  bus.on(T.DRONE_SPAWN, (e) => {
    blasts.droneBeacon(e.x, e.y, e.z, 1)
    audio.bubbleBreak(e.x)
  })

  bus.on(T.DRONE_EXPIRE, (e) => {
    blasts.droneBeacon(e.x, e.y, e.z, 0)
  })

  bus.on(T.BOLT_BURST, (e) => {
    blasts.boltBurst(e.x, e.y, e.z, e.a)
    if (e.a > 0) audio.impact(e.x)
  })

  bus.on(T.BLOAT, (e) => {
    // A bloater's blast chews through whatever crowd it died in, so it should
    // read as a reward for shooting it early rather than as damage to you.
    camera.addTrauma(trauma.barrelDead * 0.7)
    blasts.bloater(e.x, e.y, e.z, e.a)
    audio.explosion(e.x)
  })

  // ---- boss -----------------------------------------------------------------

  bus.on(T.BOSS_SPAWN, () => camera.punchFov(4))

  bus.on(T.BOSS_FOOTFALL, (e) => {
    camera.addTrauma(trauma.bossFootfall)
    particles.burst('dust', e.x, 0.1, e.z, 10)
    audio.bossThud(e.x)
  })

  bus.on(T.BOSS_SLAM, (e) => {
    camera.addTrauma(trauma.bossSlam)
    audio.bossSlam(e.x)
  })

  bus.on(T.BOSS_PLATE, (e) => {
    blasts.bossPlate(e.x, e.y, e.z)
    camera.punchFov(-2)
  })

  bus.on(T.BOSS_RAGE, () => camera.punchFov(5))

  bus.on(T.BOSS_DEAD, (e) => {
    const [scale, hold, ramp] = CFG.fx.hitstopBossDeath
    loop.punch(scale, hold, ramp)
    camera.addTrauma(trauma.bossDeath)
    blasts.bossDeath(e.x, e.z)
    audio.bossDeath()
  })
}

function vibrate(ms) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms)
  } catch {
    /* unsupported or blocked by permissions policy */
  }
}
