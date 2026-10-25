// The ascent curve and the scale trick (port of Flight.swift).
//
// Altitude grows exponentially so the perceived speed stays constant. The
// user never moves far: the world sits a fixed `RENDERED_ALTITUDE` below the
// eyes once airborne and is scaled down instead. Perspective is scale
// invariant and stereo disparity at 50 m is already nil, so it looks the same
// while every coordinate stays well inside Float32.

export const HEAD_HEIGHT = 1.6;
const RENDERED_ALTITUDE = 50;
const A0 = 1.0;
const RATE = 0.24;
export const END_ALTITUDE = 40_000_000;
const PITCH_START = 3_000_000;
const PITCH_DURATION = 12;
const MAX_PITCH = (65 * Math.PI) / 180;

// Faster through the smoke: ceiling to 200 m in ~5 s instead of ~16 s.
const BOOST = 3, BOOST_START = 1.5, BOOST_FULL = 4, BOOST_TAPER = 120, BOOST_END = 400;

const ramp = (x, lo, hi) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };

export class Flight {
  constructor() { this.u = 0; this.pitchTime = 0; this.minAscent = 0; }

  static ascentAt(u) { return Math.min(A0 * (Math.exp(u) - 1), END_ALTITUDE); }
  static boostAt(a) {
    const up = ramp(a, BOOST_START, BOOST_FULL);
    const down = 1 - ramp(Math.log(Math.max(a, 1)), Math.log(BOOST_TAPER), Math.log(BOOST_END));
    return 1 + (BOOST - 1) * up * down;
  }

  /** Metres climbed above the floor. */
  get ascent() { return Flight.ascentAt(this.u); }
  get altitude() { return this.ascent + HEAD_HEIGHT; }
  get isComplete() { return this.ascent >= END_ALTITUDE; }

  /** Uniform scale applied to the world. */
  get scale() { const a = this.ascent; return a <= 0 ? 1 : Math.min(1, (RENDERED_ALTITUDE - HEAD_HEIGHT) / a); }

  /** Rotation about X that swings the planet from below to in front at the end. */
  get pitch() { const p = Math.min(1, Math.max(0, this.pitchTime / PITCH_DURATION)); return p * p * (3 - 2 * p) * MAX_PITCH; }

  /** `speed` < 0 descends (manual control), down to `minAscent`. The finale
   *  pitch plays forward above PITCH_START and back below it. */
  advance(dt, speed, countPitch = true) {
    if (speed > 0 && !this.isComplete) this.u += RATE * Flight.boostAt(this.ascent) * dt * speed;
    if (speed < 0) this.u = Math.max(Math.log(this.minAscent / A0 + 1), this.u + RATE * dt * speed);
    if (countPitch) this.pitchTime = Math.min(PITCH_DURATION, Math.max(0, this.pitchTime + (this.ascent >= PITCH_START ? dt : -dt)));
  }

  /** Altitude `seconds` from now; used to prefetch tiles. */
  altitudeAfter(seconds, speed) {
    const f = new Flight(); f.u = this.u; f.pitchTime = this.pitchTime;
    for (let i = 0; i < 12; i++) f.advance(seconds / 12, speed, false);
    return f.altitude;
  }

  jump(target) {
    this.u = Math.log(Math.min(target, END_ALTITUDE) / A0 + 1);
    this.pitchTime = this.ascent >= PITCH_START ? PITCH_DURATION : 0;
  }
}
