/**
 * The authored beat table -- the only content file in the game.
 *
 * A beat SPAWNS at the 72u horizon at time `t`; the player meets it roughly
 * windowSeconds(t) later. Beats are ~5.5s apart, which is the constant-distance
 * spacing the scroll ramp then compresses from 6.1s to 4.0s across the run.
 *
 * PAIR is the mode's signature beat and reproduces the reference screenshot:
 * each lane has a TOLL barrel in front and a reward BUBBLE behind it. The barrel
 * blocks bullets, so the toll literally gates the reward -- you must break the
 * barrel, then the bubble, within one window, and you can only afford one lane.
 *
 * hpScale is the per-beat authoring knob on top of the role's curve. Beat `t:16`
 * is calibrated to print 62 and 210 at par DPS, matching the screenshot.
 */
export const BEATS = [
  // --- Act 1: warm-up. Cheap tolls, generous windows, teach the gating rule. ---
  { t: 5,  kind: 'pair', lanes: [
    { x: -3, toll: { role: 'cheap', hpScale: 0.30 }, reward: { type: 'soldiers' } },
    { x:  3, toll: { role: 'cheap', hpScale: 0.34 }, reward: { type: 'soldiers' } },
  ] },
  { t: 10, kind: 'cheap', lanes: [{ x: 0, hpScale: 0.45 }] },
  { t: 16, kind: 'pair', lanes: [
    { x: -3, toll: { role: 'cheap', hpScale: 0.39 }, reward: { type: 'soldiers' } },
    { x:  3, toll: { role: 'toll',  hpScale: 0.69 }, reward: { type: 'weapon' } },
  ] },
  { t: 21, kind: 'wall', hpScale: 0.60 },

  // --- Act 2: investment. Tolls get real; taking the greedy lane compounds. ---
  { t: 27, kind: 'pair', lanes: [
    { x:  0, toll: { role: 'cheap', hpScale: 0.55 }, reward: { type: 'soldiers' } },
    { x:  3, toll: { role: 'toll',  hpScale: 1.00 }, reward: { type: 'drone' } },
  ] },
  // First can of three (32s / 54s / 76s, one per act). The can stands in the
  // OPEN -- `toll: null` -- because a bubble behind drums is hidden until the
  // barrel dies, and the can is the one reward whose model is the read. The
  // other lane keeps a bare barrel (`reward: null`) so the beat still bites.
  { t: 32, kind: 'pair', lanes: [
    { x: -3, toll: null, reward: { type: 'wings' } },
    { x:  3, toll: { role: 'cheap', hpScale: 0.70 }, reward: null },
  ] },
  { t: 38, kind: 'pair', lanes: [
    { x: -3, toll: { role: 'cheap', hpScale: 0.60 }, reward: { type: 'soldiers' } },
    { x:  0, toll: { role: 'toll',  hpScale: 1.05 }, reward: { type: 'weapon' } },
  ] },
  { t: 43, kind: 'wall', hpScale: 0.85 },
  { t: 49, kind: 'pair', lanes: [
    { x: -3, toll: { role: 'cheap', hpScale: 0.65 }, reward: { type: 'soldiers' } },
    { x:  3, toll: { role: 'toll',  hpScale: 1.10 }, reward: { type: 'drone' } },
  ] },

  // --- Act 3: compounding. Walls arrive on top of crowds; the horde bites. ---
  // Second can: ten seconds of wings exactly where the crowd starts to
  // out-walk the squad's fire, in the open in the centre lane.
  { t: 54, kind: 'pair', lanes: [
    { x:  0, toll: null, reward: { type: 'wings' } },
  ] },
  { t: 60, kind: 'pair', lanes: [
    { x: -3, toll: { role: 'cheap', hpScale: 0.70 }, reward: { type: 'soldiers' } },
    { x:  3, toll: { role: 'toll',  hpScale: 1.15 }, reward: { type: 'weapon' } },
  ] },
  { t: 65, kind: 'wall', hpScale: 1.00 },
  { t: 71, kind: 'pair', lanes: [
    { x: -3, toll: { role: 'toll',  hpScale: 1.15 }, reward: { type: 'drone' } },
    { x:  3, toll: { role: 'cheap', hpScale: 0.72 }, reward: { type: 'soldiers' } },
  ] },
  // Third can, right lane in the open, ahead of the crescendo.
  { t: 76, kind: 'pair', lanes: [
    { x: -3, toll: { role: 'cheap', hpScale: 0.85 }, reward: null },
    { x:  3, toll: null, reward: { type: 'wings' } },
  ] },
  { t: 82, kind: 'pair', lanes: [
    { x:  0, toll: { role: 'cheap', hpScale: 0.75 }, reward: { type: 'soldiers' } },
    { x:  3, toll: { role: 'toll',  hpScale: 1.20 }, reward: { type: 'weapon' } },
  ] },
  { t: 87, kind: 'wall', hpScale: 1.10 },

  // --- Act 4: crescendo (t 96-101). Movement test, not a DPS test. ---
  { t: 93, kind: 'pair', lanes: [
    { x: -3, toll: { role: 'cheap', hpScale: 0.78 }, reward: { type: 'soldiers' } },
    { x:  3, toll: { role: 'toll',  hpScale: 1.25 }, reward: { type: 'soldiers', mult: 2 } },
  ] },

  // --- Act 5: the lull. One mercy pair so the player can read their build. ---
  { t: 103, kind: 'pair', lanes: [
    { x: -3, toll: null, reward: { type: 'soldiers', mult: 2 } },
    { x:  3, toll: null, reward: { type: 'weapon' } },
  ] },
]

/**
 * GATE ROWS -- the steering axis.
 *
 * Kept in its own table with its own cursor rather than folded into BEATS, so
 * the barrel economy above (which is calibrated against par DPS) and the gate
 * economy here can be tuned without disturbing each other.
 *
 * Each row tiles the corridor: `v` is the signed soldier change, `w` a relative
 * width. A row is a TAX ON INATTENTION, not a DPS check. The reference is
 * explicit about the asymmetry -- its gates read +1 against -4 and -40 -- so
 * the carrot stays SMALL and the punishment for drifting is what scales.
 * Generous positives turn gates into flat income and every skill tier pins at
 * the squad cap; measured at 28/30 wins before the values were cut.
 *
 * `t` is a SPAWN time solved backwards from a target ARRIVAL, not a spacing.
 * Gates spawn at 34u and beats at 72u, so evenly spaced spawns converge: every
 * row previously landed 0.3-0.8s behind a `pair` beat and blocked the squad's
 * fire exactly when it needed to break a toll and its bubble. Weapon tier
 * collapsed from 2-3 to 0-1 and only 3 of 14 bubbles were taken. Each row now
 * arrives midway between two beat arrivals, ~2.4s clear of both. Re-solve these
 * if either spawn distance changes.
 */
export const GATE_ROWS = [
  // Blue values raised one tier across the board (1->2, 2->3, 3->5): the
  // blue plate is the main recruiting beat between bubbles and it paid too
  // little to matter once the horde scales past round 2.
  { t: 10, segments: [{ v: 2, w: 1 }, { v: -3, w: 1 }] },
  { t: 21, segments: [{ v: -4, w: 1 }, { v: 2, w: 1 }] },
  // Three segments, bad in the middle: the first row that punishes holding the
  // centre lane, which is where an idle player parks.
  { t: 32, segments: [{ v: 3, w: 1 }, { v: -6, w: 1.2 }, { v: 2, w: 1 }] },
  { t: 43, segments: [{ v: -7, w: 1 }, { v: 3, w: 1 }] },
  { t: 54, segments: [{ v: 3, w: 1 }, { v: -9, w: 1 }] },
  // The good segment is now narrower than a lane: a real steering commitment.
  { t: 65, segments: [{ v: -10, w: 1.3 }, { v: 5, w: 0.9 }, { v: -10, w: 1.3 }] },
  { t: 76, segments: [{ v: 5, w: 1 }, { v: -12, w: 1 }] },
  { t: 87, segments: [{ v: -14, w: 1 }, { v: 5, w: 1 }] },
]

/** Distance behind its toll that a pair's reward bubble sits, in world units. */
export const BUBBLE_TRAIL = 7.0

/** Scripted runner sweeps during the crescendo: pure movement, no DPS answer. */
export const SWEEPS = [
  { t: 97,  gapX: 2.6, count: 14 },
  { t: 100, gapX: -2.8, count: 16 },
  { t: 103, gapX: 0.4, count: 16 },
]

/**
 * The sweep gap must be wider than the widest squad (3.15u at 40 soldiers) or
 * the finale punishes growth -- the exact inversion the mode must never make.
 */
export const SWEEP_GAP = 2.4
