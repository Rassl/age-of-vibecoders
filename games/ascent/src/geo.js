// Web Mercator tile maths and a local east/up/north frame anchored at the
// start coordinate. JS numbers are doubles, so everything here stays exact;
// three.js only ever sees small anchor-relative Float32 offsets.
// Same conventions as the visionOS app (Geo.swift): +x east, +y up, −z north.

export const EARTH_RADIUS = 6_371_000;
const MAX_LAT = 85.05112878;
const D2R = Math.PI / 180;

export const mercatorX = (lon) => (lon + 180) / 360;
export function mercatorY(lat) {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * D2R;
  return (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2;
}
export const lonFromMercatorX = (x) => x * 360 - 180;
export function latFromMercatorY(y) {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Unit vector from Earth's centre. Y is the polar axis. */
export function unit(lat, lon) {
  const a = lat * D2R, o = lon * D2R;
  return [Math.cos(a) * Math.cos(o), Math.sin(a), Math.cos(a) * Math.sin(o)];
}

export class TileKey {
  constructor(z, x, y) { this.z = z; this.x = x; this.y = y; }
  get n() { return 1 << this.z; }
  get minX() { return this.x / this.n; }
  get maxX() { return (this.x + 1) / this.n; }
  get minY() { return this.y / this.n; }
  get maxY() { return (this.y + 1) / this.n; }
  get id() { return `${this.z}/${this.x}/${this.y}`; }

  static containing(lat, lon, z) {
    const n = 1 << z;
    const x = Math.floor(mercatorX(lon) * n), y = Math.floor(mercatorY(lat) * n);
    return new TileKey(z, Math.min(Math.max(x, 0), n - 1), Math.min(Math.max(y, 0), n - 1));
  }

  /** Ground width of one tile at this zoom, metres. */
  static groundSize(z, lat) {
    return (2 * Math.PI * EARTH_RADIUS * Math.cos(lat * D2R)) / (1 << z);
  }

  /** size×size tiles around the one containing the coordinate; X wraps, Y clamps. */
  static block(lat, lon, z, size) {
    const c = TileKey.containing(lat, lon, z), n = 1 << z;
    const out = [], seen = new Set();
    const lo = -Math.floor(size / 2), hi = size - Math.floor(size / 2) - 1;
    for (let dy = lo; dy <= hi; dy++) {
      for (let dx = lo; dx <= hi; dx++) {
        const y = c.y + dy;
        if (y < 0 || y >= n) continue;
        const x = (((c.x + dx) % n) + n) % n;
        const k = new TileKey(z, x, y);
        if (!seen.has(k.id)) { seen.add(k.id); out.push(k); }
      }
    }
    return out;
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Tangent frame at the anchor: +x east, +y up, −z north. */
export class LocalFrame {
  constructor(lat, lon) {
    this.lat = lat; this.lon = lon;
    this.up = unit(lat, lon);
    this.origin = this.up.map((v) => v * EARTH_RADIUS);
    const o = lon * D2R;
    this.east = [-Math.sin(o), 0, Math.cos(o)];
    this.north = cross(this.east, this.up);
  }

  /** Local position (doubles) of a point on a sphere of `radius`. */
  position(lat, lon, radius = EARTH_RADIUS) {
    const u = unit(lat, lon);
    const p = [u[0] * radius - this.origin[0], u[1] * radius - this.origin[1], u[2] * radius - this.origin[2]];
    return [dot(p, this.east), dot(p, this.up), -dot(p, this.north)];
  }

  direction(lat, lon) {
    const d = unit(lat, lon);
    return [dot(d, this.east), dot(d, this.up), -dot(d, this.north)];
  }

  /** Local-frame vector → Earth-fixed (Geo convention: y polar). */
  toEcef(v) {
    const { east: e, up: u, north: n } = this;
    return [e[0] * v[0] + u[0] * v[1] - n[0] * v[2], e[1] * v[0] + u[1] * v[1] - n[1] * v[2], e[2] * v[0] + u[2] * v[1] - n[2] * v[2]];
  }

  /** East, up and south at another point, as vectors in this frame. */
  basisAt(lat, lon) {
    const f = new LocalFrame(lat, lon);
    const toLocal = (d) => [dot(d, this.east), dot(d, this.up), -dot(d, this.north)];
    return { east: toLocal(f.east), up: toLocal(f.up), south: toLocal(f.north.map((v) => -v)) };
  }

  get earthCentre() { return [0, -EARTH_RADIUS, 0]; }
}
