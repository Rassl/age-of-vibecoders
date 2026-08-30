/**
 * Deterministic RNG (mulberry32) so a run can be replayed from a seed.
 * Never use Math.random() in gameplay code -- use an Rng instance, so that
 * balance problems are reproducible.
 */
export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.seed = seed >>> 0
  }

  /** float in [0,1) */
  next() {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0
    let t = this.seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** float in [min,max) */
  range(min, max) {
    return min + this.next() * (max - min)
  }

  /** integer in [min,max] inclusive */
  int(min, max) {
    return Math.floor(this.range(min, max + 1))
  }

  /** true with probability p */
  chance(p) {
    return this.next() < p
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)]
  }

  /** random sign, -1 or 1 */
  sign() {
    return this.next() < 0.5 ? -1 : 1
  }
}
