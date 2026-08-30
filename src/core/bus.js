/**
 * One-directional event bus over a pre-allocated ring.
 *
 * RULE: sim emits FACTS, presentation listens. sim -> sim causality is direct
 * function calls, never the bus -- tools/harness.mjs fails the build if anything
 * under src/sim/ subscribes. This is what keeps "what happens when a barrel
 * dies" answerable in one place (src/reactions.js) rather than scattered across
 * nine systems.
 *
 * Events carry a fixed numeric shape so emitting never allocates.
 */
import { CFG } from '../config.js'

export const T = {
  HIT: 1,
  KILL: 2,
  TRACER: 3,
  MUZZLE: 4,
  BARREL_DEAD: 5,
  BARREL_BREACH: 6,
  BARREL_DODGED: 7,
  BUBBLE_BREAK: 8,
  BUBBLE_MISS: 9,
  SOLDIER_LOSS: 10,
  SOLDIER_GAIN: 11,
  COUNT_CHANGED: 12,
  WEAPON_UP: 13,
  BOSS_SPAWN: 14,
  BOSS_FOOTFALL: 15,
  BOSS_SLAM: 16,
  BOSS_PLATE: 17,
  BOSS_DEAD: 18,
  BOSS_RAGE: 19,
  RUN_OVER: 20,
  BEAT: 21,
  SPIT_WINDUP: 22,
  SPIT_FIRE: 23,
  SPIT_LAND: 24,
  BLOAT: 25,
  GATE_PASS: 26,
  GATE_MISS: 27,
  GATE_TICK: 28,
  DRONE_SPAWN: 29,
  DRONE_EXPIRE: 30,
  DRONE_FIRE: 31,
  BOLT_BURST: 32,
}

export const TOPIC_NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]))

class Bus {
  constructor(capacity) {
    this.capacity = capacity
    this.head = 0
    this.overflow = 0
    this.events = new Array(capacity)
    for (let i = 0; i < capacity; i++) {
      // Fixed monomorphic shape. Never add fields at runtime.
      this.events[i] = { topic: 0, x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, kind: 0 }
    }
    this.handlers = new Map()
  }

  /** Zero-allocation emit. Returns the event so the caller may set extra fields. */
  emit(topic, x = 0, y = 0, z = 0, a = 0, b = 0, c = 0, kind = 0) {
    if (this.head >= this.capacity) {
      this.overflow++
      return null
    }
    const e = this.events[this.head++]
    e.topic = topic; e.x = x; e.y = y; e.z = z
    e.a = a; e.b = b; e.c = c; e.kind = kind
    return e
  }

  on(topic, fn) {
    let list = this.handlers.get(topic)
    if (!list) this.handlers.set(topic, (list = []))
    list.push(fn)
    return this
  }

  /**
   * Drain ONCE PER FRAME, not per substep -- otherwise a 3-substep frame fires
   * three explosion bursts for what the player perceives as one event.
   */
  drain() {
    for (let i = 0; i < this.head; i++) {
      const e = this.events[i]
      const list = this.handlers.get(e.topic)
      if (list) for (let h = 0; h < list.length; h++) list[h](e)
    }
    this.head = 0
  }

  clear() {
    this.head = 0
    this.overflow = 0
  }
}

export const bus = new Bus(CFG.pool.eventRing)
