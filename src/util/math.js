/** Small math helpers. Frame-rate independent where it matters. */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

export const lerp = (a, b, t) => a + (b - a) * t

/**
 * Frame-rate independent exponential smoothing.
 * `smoothing` is the fraction of the remaining distance left after 1 second.
 * e.g. damp(x, target, 0.001, dt) closes 99.9% of the gap per second.
 */
export const damp = (a, b, smoothing, dt) => lerp(a, b, 1 - Math.pow(smoothing, dt))

export const smoothstep = (t) => t * t * (3 - 2 * t)

/** Remap v from [inA,inB] to [outA,outB], clamped. */
export const remap = (v, inA, inB, outA, outB) =>
  outA + (outB - outA) * clamp((v - inA) / (inB - inA || 1), 0, 1)

/** Approach a target by at most `maxDelta` this step. */
export const approach = (a, b, maxDelta) => {
  const d = b - a
  return Math.abs(d) <= maxDelta ? b : a + Math.sign(d) * maxDelta
}
