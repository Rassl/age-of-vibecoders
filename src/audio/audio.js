/**
 * Every sound in the game, synthesised. There are no audio files and none may be added.
 *
 * THE MIX IS THE FEATURE. Forty soldiers firing is not forty voices: past a hard cap of
 * ~9 new voices per second, shots stop being added and a continuous filtered-noise
 * CROWD-FIRE BED takes over the energy instead. Adding a voice per trigger pins the
 * compressor and turns the loudest moment of the run into mush — a big squad has to get
 * BIGGER, not louder, and that is a routing decision rather than a gain one.
 *
 * Nothing here is constructed until the first user gesture: creating an AudioContext
 * before one is what trips the autoplay policy, and an autoplay exception must never
 * reach the game loop. Every entry point is a no-op until the context reports 'running',
 * and a missing or throwing WebAudio degrades this whole module to silence.
 *
 * The view may never touch w.rng — every random here is Math.random(), because one
 * cosmetic draw from the sim's stream desynchronises replay and the headless harness.
 */
import { CFG } from '../config.js'
import { WEAPONS, TURRET, TURRET_TIER } from '../data/weapons.js'
import { clamp, damp } from '../util/math.js'

// Compressor first, always: 20+ soldiers firing into a bare gain node clips on frame one.
const COMP = { threshold: -16, knee: 8, ratio: 5, attack: 0.003, release: 0.14 }
const MASTER = 0.75

// Voice budget. credit refills at VOICE_RATE/s and every voice costs 1; a sound may only
// fire while credit is above the floor for its priority, so explosions and losses still
// cut through a wall of denied gunshots.
const VOICE_RATE = 9
const VOICE_BURST = 3
const P_SHOT = 0, P_TICK = 1, P_BIG = 2, P_END = 3
const CREDIT_FLOOR = [1, 0.25, -3, -8]
const SLOTS = 16
const STEAL_FADE = 0.008

// Never hard-panned: at 9 shots/s a full-width pan is fatiguing on headphones, and in
// portrait the corridor is only ~9u wide on screen anyway.
const PAN_WIDTH = 0.7

// Per-shot randomisation. An identical burst repeated at 5Hz is the single most audible
// tell of a cheap game, so rate/filter/gain are jittered on EVERY trigger.
const RATE_MIN = 0.92, RATE_MAX = 1.08
const FILT_JIT = 0.12
const GAIN_JIT = 0.15

// Tier changes timbre, not just level: the transient waveform and the noise band move
// with WEAPONS[t].shotHz, so the minigun ticks and the shotgun booms.
const SHOT_WAVE = ['square', 'square', 'sawtooth', 'triangle']

const BED_GAIN = 0.20
const BED_LOW_GAIN = 0.24
const BED_UP = 0.004      // damp() smoothing: fraction of the gap left after 1s
const BED_DOWN = 0.06
const DENY_SMOOTH = 0.02
const DENY_REF = 260      // denied shots/s that saturate the bed (~40 soldiers on minigun)

const PENTA = [659.26, 783.99, 880.0, 1046.5, 1318.5]
const ARP = [523.25, 659.25, 783.99]

// STATE ids are duplicated from sim/world.js rather than imported: the view reads sim
// DATA, never sim modules.
const ST_READY = 0, ST_WON = 3, ST_LOST = 4

const rnd = (a, b) => a + Math.random() * (b - a)
const jit = (v, f) => v * (1 + (Math.random() * 2 - 1) * f)

/** Percussive envelope. The exponential tail must not reach 0 — that throws. */
function env(p, t, peak, dur, attack = 0.003) {
  p.setValueAtTime(0, t)
  p.linearRampToValueAtTime(peak, t + attack)
  p.exponentialRampToValueAtTime(1e-4, t + dur)
  p.setValueAtTime(0, t + dur)
}

/** Deadbanded direct write. setTargetAtTime() every frame would pile automation events
 *  onto a param we already smooth in JS, and the timeline never shrinks. */
function wr(p, v, eps) {
  if (Math.abs(p.value - v) > eps) p.value = v
}

function makeNoise(ctx, seconds) {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
  return buf
}

/**
 * A 0..1 contour of ~18 random pulses per second. The bed is multiplied by it because
 * steady filtered noise reads as WIND; the irregular pulse train is what makes the same
 * noise read as many overlapping guns.
 */
function makeChatter(ctx, seconds) {
  const sr = ctx.sampleRate
  const n = Math.floor(sr * seconds)
  const buf = ctx.createBuffer(1, n, sr)
  const d = buf.getChannelData(0)
  const seg = Math.max(1, Math.floor(sr / 18))
  const decay = Math.exp(-1 / (sr * 0.035))
  let e = 0
  for (let i = 0; i < n; i++) {
    if (i % seg === 0) e = 0.35 + Math.random() * 0.65
    d[i] = e
    e *= decay
  }
  return buf
}

export function createAudio() {
  let ctx = null
  let ok = true
  let hasPan = false
  let master = null, comp = null, duckBus = null, hardBus = null
  let bedLP = null, bedGain = null, bedLowGain = null
  let noiseBuf = null

  let muted = false
  let credit = VOICE_BURST
  let creditT = 0
  let denied = 0
  let denyHz = 0
  let intensity = 0
  let bedDrive = 0
  let crowd = 0

  const slots = new Array(SLOTS)
  for (let i = 0; i < SLOTS; i++) slots[i] = { g: null, endT: 0, prio: 0 }

  function live() {
    return ok && ctx !== null && ctx.state === 'running'
  }

  /** Build the graph on the first gesture. One failure here mutes the game for good
   *  rather than throwing into whatever called us. */
  function boot() {
    if (ctx) return true
    if (!ok) return false
    try {
      const g = typeof globalThis !== 'undefined' ? globalThis : null
      const AC = g && (g.AudioContext || g.webkitAudioContext)
      if (!AC) { ok = false; return false }
      ctx = new AC({ latencyHint: 'interactive' })
      hasPan = typeof ctx.createStereoPanner === 'function'

      master = ctx.createGain()
      master.gain.value = muted ? 0 : MASTER
      master.connect(ctx.destination)

      comp = ctx.createDynamicsCompressor()
      comp.threshold.value = COMP.threshold
      comp.knee.value = COMP.knee
      comp.ratio.value = COMP.ratio
      comp.attack.value = COMP.attack
      comp.release.value = COMP.release
      comp.connect(master)

      // A real sidechain: everything duckable goes through duckBus, while the sounds
      // that CAUSE the duck (explosions, losses, the boss) land on hardBus behind it.
      // Ducking one shared master would gut the attack of the very hit being sold.
      duckBus = ctx.createGain()
      duckBus.gain.value = 1
      duckBus.connect(comp)

      hardBus = ctx.createGain()
      hardBus.gain.value = 1
      hardBus.connect(comp)

      noiseBuf = makeNoise(ctx, 2.5)

      const bedSrc = ctx.createBufferSource()
      bedSrc.buffer = noiseBuf
      bedSrc.loop = true

      const bedHP = ctx.createBiquadFilter()
      bedHP.type = 'highpass'
      bedHP.frequency.value = 140      // sub rumble here would pump the compressor

      bedLP = ctx.createBiquadFilter()
      bedLP.type = 'lowpass'
      bedLP.frequency.value = 420
      bedLP.Q.value = 0.7

      const bedTrem = ctx.createGain()
      bedTrem.gain.value = 0.12        // floor; the chatter source rides on top

      bedGain = ctx.createGain()
      bedGain.gain.value = 0

      bedSrc.connect(bedHP)
      bedHP.connect(bedLP)
      bedLP.connect(bedTrem)
      bedTrem.connect(bedGain)
      bedGain.connect(duckBus)

      // Crowd body: the same noise through a fixed low shelf, gated by squad size. This
      // is the "more soldiers" cue — the shots themselves never get louder.
      const bedLowLP = ctx.createBiquadFilter()
      bedLowLP.type = 'lowpass'
      bedLowLP.frequency.value = 170
      bedLowLP.Q.value = 0.8
      bedLowGain = ctx.createGain()
      bedLowGain.gain.value = 0
      bedSrc.connect(bedLowLP)
      bedLowLP.connect(bedLowGain)
      bedLowGain.connect(duckBus)

      const chatterSrc = ctx.createBufferSource()
      chatterSrc.buffer = makeChatter(ctx, 2.0)
      chatterSrc.loop = true
      const chatterDepth = ctx.createGain()
      chatterDepth.gain.value = 0.85
      chatterSrc.connect(chatterDepth)
      chatterDepth.connect(bedTrem.gain)

      bedSrc.start()
      chatterSrc.start()
      creditT = ctx.currentTime
      return true
    } catch {
      ctx = null
      ok = false
      return false
    }
  }

  function spend(prio, now) {
    credit = Math.min(VOICE_BURST, credit + (now - creditT) * VOICE_RATE)
    creditT = now
    if (credit < CREDIT_FLOOR[prio]) return false
    credit -= 1
    return true
  }

  /**
   * Take a slot, stealing the weakest LOWER-priority voice if all are busy. A stolen
   * voice fades over 8ms instead of being cut, and is dropped rather than disconnected:
   * its sources already carry a scheduled stop().
   */
  function claim(prio, now, endT) {
    let free = -1, weak = -1, weakPrio = 99, weakEnd = 0
    for (let i = 0; i < SLOTS; i++) {
      const s = slots[i]
      if (s.endT <= now) { free = i; break }
      if (s.prio < weakPrio || (s.prio === weakPrio && s.endT > weakEnd)) {
        weak = i; weakPrio = s.prio; weakEnd = s.endT
      }
    }
    if (free < 0) {
      if (weak < 0 || weakPrio >= prio) return null
      const old = slots[weak].g
      if (old) {
        old.gain.cancelScheduledValues(now)
        old.gain.setValueAtTime(old.gain.value, now)
        old.gain.linearRampToValueAtTime(0, now + STEAL_FADE)
      }
      slots[weak].g = null
      free = weak
    }
    const s = slots[free]
    if (s.g) { s.g.disconnect(); s.g = null }  // detaching the head frees its whole chain
    s.prio = prio
    s.endT = endT
    return s
  }

  /** Head node for one voice: gain -> pan -> bus. Returns null when the budget says no. */
  function voice(prio, dur, x, dest) {
    const now = ctx.currentTime
    if (!spend(prio, now)) return null
    const s = claim(prio, now, now + dur + 0.05)
    if (!s) return null
    const g = ctx.createGain()
    s.g = g
    if (hasPan) {
      const p = ctx.createStereoPanner()
      p.pan.value = clamp(x / CFG.world.railX, -1, 1) * PAN_WIDTH
      g.connect(p)
      p.connect(dest)
    } else {
      g.connect(dest)
    }
    return g
  }

  /** Looping noise slice. The random offset means two bursts never share a waveform. */
  function noise(t, dur, rate) {
    const s = ctx.createBufferSource()
    s.buffer = noiseBuf
    s.loop = true
    s.playbackRate.value = rate
    s.start(t, Math.random() * noiseBuf.duration)
    s.stop(t + dur)
    return s
  }

  function biquad(type, freq, q) {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    if (q !== undefined) f.Q.value = q
    return f
  }

  function gainAt(t, peak, dur, attack) {
    const g = ctx.createGain()
    env(g.gain, t, peak, dur, attack)
    return g
  }

  /** Explosions duck the rest of the mix rather than shouting over it. */
  function duckNow(amount, hold) {
    const t = ctx.currentTime
    duckBus.gain.cancelScheduledValues(t)
    duckBus.gain.setValueAtTime(duckBus.gain.value, t)
    duckBus.gain.setTargetAtTime(amount, t, 0.012)
    duckBus.gain.setTargetAtTime(1, t + hold, 0.09)
  }

  // ------------------------------------------------------------------ synthesis

  function shotVoice(tier, x) {
    // The turret is not a tier, so it names itself: TURRET_TIER selects its
    // own row and every other index clamps into the squad's roster.
    const w = tier === TURRET_TIER ? TURRET : WEAPONS[clamp(tier | 0, 0, WEAPONS.length - 1)]
    const hz = w.shotHz
    // Lower shotHz => darker band and a longer tail (shotgun); higher => tight and
    // clicky (minigun). The tier is audible before the level is.
    const band = 900 + hz * 2.2
    const dur = clamp(0.115 - hz * 0.00016, 0.045, 0.12)
    const out = voice(P_SHOT, dur + 0.06, x, duckBus)
    if (!out) { denied++; return }
    out.gain.value = w.shotGain * jit(1, GAIN_JIT)

    const t = ctx.currentTime
    const rate = rnd(RATE_MIN, RATE_MAX)

    const n = noise(t, dur + 0.02, rate)
    const bp = biquad('bandpass', jit(band, FILT_JIT), 0.9)
    const ng = gainAt(t, 0.85, dur)
    n.connect(bp); bp.connect(ng); ng.connect(out)

    // Pitched transient. Crowd size lands here as extra low body instead of extra
    // voices, which is what makes 40 soldiers read as heavy rather than as loud.
    const o = ctx.createOscillator()
    o.type = SHOT_WAVE[clamp(tier | 0, 0, SHOT_WAVE.length - 1)]
    const f0 = hz * rate * 0.6
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(f0 * (0.20 - 0.06 * crowd), t + 0.045)
    const lp = biquad('lowpass', jit(900, FILT_JIT), 0.9)
    const og = gainAt(t, 0.5 * (1 + 0.8 * crowd), dur * 0.9)
    o.connect(lp); lp.connect(og); og.connect(out)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  function impactVoice(x) {
    const out = voice(P_SHOT, 0.08, x, duckBus)
    if (!out) return
    out.gain.value = 0.16 * jit(1, GAIN_JIT)
    const t = ctx.currentTime
    const n = noise(t, 0.045, rnd(RATE_MIN, RATE_MAX))
    const hp = biquad('highpass', jit(1800, FILT_JIT))
    const bp = biquad('bandpass', jit(3200, FILT_JIT), 1.4)
    const g = gainAt(t, 1, 0.035, 0.001)
    n.connect(hp); hp.connect(bp); bp.connect(g); g.connect(out)
  }

  function explosionVoice(x) {
    const out = voice(P_BIG, 0.75, x, hardBus)
    if (!out) return
    out.gain.value = 0.9 * jit(1, GAIN_JIT)
    duckNow(0.7, 0.18)
    const t = ctx.currentTime

    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(jit(90, 0.08), t)
    o.frequency.exponentialRampToValueAtTime(38, t + 0.45)
    const og = gainAt(t, 1, 0.55, 0.004)
    o.connect(og); og.connect(out)
    o.start(t); o.stop(t + 0.6)

    const n = noise(t, 0.62, rnd(RATE_MIN, RATE_MAX))
    const lp = biquad('lowpass', jit(900, FILT_JIT), 0.8)
    lp.frequency.setValueAtTime(lp.frequency.value, t)  // an implicit ramp start is not portable
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.6)
    const ng = gainAt(t, 0.55, 0.6, 0.005)
    n.connect(lp); lp.connect(ng); ng.connect(out)

    // Debris tail, deliberately late: the gap is what gives the blast a size.
    const d = noise(t + 0.03, 0.4, rnd(RATE_MIN, RATE_MAX))
    const hp = biquad('highpass', jit(2400, FILT_JIT))
    const dg = gainAt(t + 0.03, 0.14, 0.38, 0.02)
    d.connect(hp); hp.connect(dg); dg.connect(out)
  }

  function bubbleVoice(x) {
    const out = voice(P_TICK, 0.5, x, duckBus)
    if (!out) return
    out.gain.value = 0.42 * jit(1, GAIN_JIT)
    const t = ctx.currentTime
    for (let i = 0; i < PENTA.length; i++) {
      const st = t + i * 0.026
      const o = ctx.createOscillator()
      o.type = 'triangle'
      o.frequency.value = jit(PENTA[i], 0.012)
      const g = gainAt(st, 0.5, 0.22, 0.002)
      o.connect(g); g.connect(out)
      o.start(st); o.stop(st + 0.24)
    }
    const n = noise(t, 0.05, rnd(RATE_MIN, RATE_MAX))
    const hp = biquad('highpass', jit(4000, FILT_JIT))
    const ng = gainAt(t, 0.2, 0.04, 0.001)
    n.connect(hp); hp.connect(ng); ng.connect(out)
  }

  function pickupVoice(x) {
    const out = voice(P_TICK, 0.4, x, duckBus)
    if (!out) return
    out.gain.value = 0.34 * jit(1, GAIN_JIT)
    const t = ctx.currentTime
    for (let i = 0; i < ARP.length; i++) {
      const st = t + i * 0.055
      const o = ctx.createOscillator()
      o.type = 'triangle'
      o.frequency.value = jit(ARP[i], 0.008)
      const g = gainAt(st, 0.55, 0.2, 0.004)
      o.connect(g); g.connect(out)
      o.start(st); o.stop(st + 0.22)
    }
  }

  function lossVoice(x) {
    const out = voice(P_BIG, 0.45, x, hardBus)
    if (!out) return
    out.gain.value = 0.85 * jit(1, GAIN_JIT)
    const t = ctx.currentTime

    // Deliberately NOT a pitched fall: a musical interval sits in the same register as
    // the fire bed and disappears inside it. Fast drop, short tail, no interval — the
    // one sound in the game that must never be mistaken for gunfire.
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(jit(78, 0.05), t)
    o.frequency.exponentialRampToValueAtTime(41, t + 0.07)
    const og = gainAt(t, 1, 0.3, 0.002)
    o.connect(og); og.connect(out)
    o.start(t); o.stop(t + 0.32)

    const n = noise(t, 0.12, rnd(RATE_MIN, RATE_MAX))
    const lp = biquad('lowpass', jit(380, FILT_JIT), 0.6)
    const ng = gainAt(t, 0.5, 0.1, 0.001)
    n.connect(lp); lp.connect(ng); ng.connect(out)
  }

  function thudVoice(x) {
    const out = voice(P_BIG, 0.6, x, hardBus)
    if (!out) return
    out.gain.value = 0.9 * jit(1, GAIN_JIT)
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(jit(42, 0.04) * 1.5, t)
    o.frequency.exponentialRampToValueAtTime(jit(42, 0.04), t + 0.035)
    const og = gainAt(t, 1, 0.5, 0.004)
    o.connect(og); og.connect(out)
    o.start(t); o.stop(t + 0.55)

    const n = noise(t, 0.36, rnd(RATE_MIN, RATE_MAX))
    const lp = biquad('lowpass', jit(260, FILT_JIT), 0.7)
    const ng = gainAt(t, 0.18, 0.34, 0.01)
    n.connect(lp); lp.connect(ng); ng.connect(out)
  }

  function slamVoice(x) {
    const out = voice(P_BIG, 1.0, x, hardBus)
    if (!out) return
    out.gain.value = 1.0 * jit(1, GAIN_JIT)
    duckNow(0.68, 0.22)
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(jit(70, 0.05), t)
    o.frequency.exponentialRampToValueAtTime(30, t + 0.25)
    const og = gainAt(t, 1, 0.9, 0.003)
    o.connect(og); og.connect(out)
    o.start(t); o.stop(t + 0.95)

    const n = noise(t, 0.3, rnd(RATE_MIN, RATE_MAX))
    const bp = biquad('bandpass', jit(1400, FILT_JIT), 0.7)
    const ng = gainAt(t, 0.4, 0.25, 0.001)
    n.connect(bp); bp.connect(ng); ng.connect(out)
  }

  function deathVoice() {
    const out = voice(P_END, 2.6, 0, hardBus)
    if (!out) return
    out.gain.value = 1.0
    duckNow(0.6, 0.9)
    const t = ctx.currentTime

    const lp = biquad('lowpass', 3200, 4)
    lp.frequency.setValueAtTime(3200, t)
    lp.frequency.exponentialRampToValueAtTime(120, t + 2.2)
    const g = gainAt(t, 0.7, 2.4, 0.02)
    lp.connect(g); g.connect(out)
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.setValueAtTime(220 * (i ? 1.006 : 1), t)
      o.frequency.exponentialRampToValueAtTime(28, t + 2.2)
      o.connect(lp)
      o.start(t); o.stop(t + 2.5)
    }

    const n = noise(t, 2.4, 0.7)
    const nlp = biquad('lowpass', 220, 0.8)
    const ng = gainAt(t, 0.5, 2.4, 0.05)
    n.connect(nlp); nlp.connect(ng); ng.connect(out)
  }

  // ----------------------------------------------------------------------- api

  return {
    /**
     * Mute at the MASTER node, not by tearing the graph down: the context and
     * every voice keep running, so unmuting is instant and mid-sound. Safe to
     * call before the first gesture -- boot() reads the flag.
     */
    setMuted(m) {
      muted = !!m
      if (!master || !ctx) return
      try {
        const t = ctx.currentTime
        master.gain.cancelScheduledValues(t)
        master.gain.setTargetAtTime(muted ? 0 : MASTER, t, 0.02)
      } catch { }
    },

    /** Halt the whole context (game pause). resume() undoes it. */
    suspend() {
      try {
        if (ctx && ctx.state === 'running') {
          const p = ctx.suspend()
          if (p && typeof p.catch === 'function') p.catch(swallow)
        }
      } catch { }
    },

    /** Must be called from a user gesture; the context does not exist before it. */
    resume() {
      try {
        if (!boot()) return
        if (ctx.state !== 'running') {
          const p = ctx.resume()
          if (p && typeof p.catch === 'function') p.catch(swallow)
        }
      } catch { ok = false }
    },

    /** @param {number} tier weapon tier 0..3  @param {number} pan source x in world units */
    shot(tier, pan) {
      if (!live()) return
      try { shotVoice(tier, pan || 0) } catch { }
    },

    impact(x) {
      if (!live()) return
      try { impactVoice(x || 0) } catch { }
    },

    explosion(x) {
      if (!live()) return
      try { explosionVoice(x || 0) } catch { }
    },

    bubbleBreak(x) {
      if (!live()) return
      try { bubbleVoice(x || 0) } catch { }
    },

    pickup(x) {
      if (!live()) return
      try { pickupVoice(x || 0) } catch { }
    },

    loss(x) {
      if (!live()) return
      try { lossVoice(x || 0) } catch { }
    },

    bossThud(x) {
      if (!live()) return
      try { thudVoice(x || 0) } catch { }
    },

    bossSlam(x) {
      if (!live()) return
      try { slamVoice(x || 0) } catch { }
    },

    bossDeath() {
      if (!live()) return
      try { deathVoice() } catch { }
    },

    /** 0..1 floor under the crowd-fire bed, for danger the shot rate does not express. */
    setIntensity(v) {
      intensity = clamp(v || 0, 0, 1)
    },

    /**
     * Allocation-free: numbers and direct AudioParam writes only, no nodes, no closures.
     * Called every frame, so a single literal here is a per-frame allocation.
     */
    sync(dt, w) {
      // The view contract passes (w, dt) and this module is specified as (dt, w).
      // Tolerating both is cheap; an object arriving as dt makes every bed parameter
      // NaN, and NaN into an AudioParam is silence with no error anywhere.
      if (dt !== null && typeof dt === 'object') { const s = dt; dt = w; w = s }
      if (!live()) return
      const d = clamp(dt || 0, 0, 0.1)

      // Shots the voice cap refused ARE the crowd-fire bed: the energy is rerouted, not
      // discarded, which is why the squad keeps growing after the cap is reached.
      denyHz = damp(denyHz, denied / Math.max(d, 1e-3), DENY_SMOOTH, d)
      denied = 0

      let target = clamp(Math.sqrt(denyHz / DENY_REF), 0, 1)
      if (intensity > target) target = intensity

      if (w) {
        crowd = clamp((w.count || 0) / CFG.squad.intensityRef, 0, 1)
        const st = w.state
        if (st === ST_READY || st === ST_WON || st === ST_LOST) target = 0
      }

      bedDrive = damp(bedDrive, target, target > bedDrive ? BED_UP : BED_DOWN, d)

      wr(bedGain.gain, bedDrive * BED_GAIN, 1e-4)
      wr(bedLowGain.gain, bedDrive * BED_LOW_GAIN * (0.35 + 0.65 * crowd), 1e-4)
      wr(bedLP.frequency, 420 + 2600 * bedDrive, 0.5)
    },

    /** Instant restart: silence every live voice and rewind the budget. No teardown. */
    reset() {
      intensity = 0
      bedDrive = 0
      denied = 0
      denyHz = 0
      crowd = 0
      credit = VOICE_BURST
      if (!ctx) return
      try {
        const t = ctx.currentTime
        creditT = t
        for (let i = 0; i < SLOTS; i++) {
          const s = slots[i]
          if (s.g) {
            s.g.gain.cancelScheduledValues(t)
            s.g.gain.setValueAtTime(s.g.gain.value, t)
            s.g.gain.linearRampToValueAtTime(0, t + 0.02)
            s.g = null
          }
          s.endT = 0
          s.prio = 0
        }
        duckBus.gain.cancelScheduledValues(t)
        duckBus.gain.value = 1
        bedGain.gain.value = 0
        bedLowGain.gain.value = 0
      } catch { }
    },

    /** Teardown only. Never called during play. */
    dispose() {
      ok = false
      if (!ctx) return
      try { ctx.close() } catch { }
      ctx = null
    },
  }
}

function swallow() { }
