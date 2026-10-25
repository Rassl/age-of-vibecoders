// Everything "infinitely far" (port of SkyDome.swift): the Milky Way, the
// naked-eye stars, the sun, the daylight haze that thins out with altitude
// and the photographed day sky (Poly Haven, CC0) with its zenith cap.
// All layers are centred on the eye and drawn first, without depth, in a
// fixed order: Milky Way, stars, haze, day sky, sun.

import * as THREE from 'three';

// Small and centred on the eye (main.js moves the root with the head): at a
// few hundred metres there is no stereo disparity left, and the sky stays
// well inside the far plane Safari's WebXR session actually uses.
const RADIUS = 400;
const CAP_FROM = ((90 - 11.5) * Math.PI) / 180;

/** Afternoon sun to the west-southwest; elevation matches daysky.jpg. */
export const SUN_DIRECTION = (() => {
  const az = (240 * Math.PI) / 180, el = (47.7 * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
})();

const smoothstep = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** Blended but in the opaque pass (transparent: false + custom blending), so
 *  three sorts the sky purely by renderOrder and draws it before anything else. */
export const BACKGROUND_BLEND = {
  transparent: false, depthWrite: false, depthTest: false,
  blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

function skyMaterial(opts) {
  return new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: false, ...BACKGROUND_BLEND, ...opts });
}

/** Equatorial → local frame matrix at `date` (GMST), as in SkyDome.celestialToLocal. */
function celestialToLocal(frame, date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  let gmst = (280.46061837 + 360.98564736629 * (jd - 2451545.0)) % 360;
  if (gmst < 0) gmst += 360;
  const g = (gmst * Math.PI) / 180, c = Math.cos(g), s = Math.sin(g);
  const local = (e) => {
    const d = [c * e[0] + s * e[1], e[2], -s * e[0] + c * e[1]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return [dot(d, frame.east), dot(d, frame.up), -dot(d, frame.north)];
  };
  const m = new THREE.Matrix3();
  const x = local([1, 0, 0]), y = local([0, 1, 0]), z = local([0, 0, 1]);
  m.set(x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]);
  return m;
}
const equatorial = (ra, dec) => new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));

/** Inward sphere (or the band between elevations `from`…`to`); v spans the band up to the zenith. */
function bandGeometry(radius, rings, slices, from = -Math.PI / 2, to = Math.PI / 2) {
  const pos = [], uv = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const phi = from + (r / rings) * (to - from);
    const v = (phi - from) / (Math.PI / 2 - from);
    for (let s = 0; s <= slices; s++) {
      const u = s / slices, th = u * 2 * Math.PI;
      pos.push(Math.cos(phi) * Math.cos(th) * radius, Math.sin(phi) * radius, Math.cos(phi) * Math.sin(th) * radius);
      uv.push(u, v);
    }
  }
  const w = slices + 1;
  for (let r = 0; r < rings; r++) for (let s = 0; s < slices; s++) {
    const a = r * w + s, b = a + 1, c = a + w, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Cap from CAP_FROM to the zenith in daysky_cap.jpg's azimuthal-equidistant layout (12° at the edge). */
function zenithCapGeometry(radius, rings = 16, slices = 96) {
  const pos = [], uv = [], idx = [];
  const capRad = (12 * Math.PI) / 180;
  for (let r = 0; r <= rings; r++) {
    const phi = CAP_FROM + (r / rings) * (Math.PI / 2 - CAP_FROM);
    const rho = (Math.PI / 2 - phi) / capRad;
    for (let s = 0; s <= slices; s++) {
      const th = (s / slices) * 2 * Math.PI;
      pos.push(Math.cos(phi) * Math.cos(th) * radius, Math.sin(phi) * radius, Math.cos(phi) * Math.sin(th) * radius);
      uv.push(0.5 + 0.5 * rho * Math.cos(th), 0.5 - 0.5 * rho * Math.sin(th));
    }
  }
  const w = slices + 1;
  for (let r = 0; r < rings; r++) for (let s = 0; s < slices; s++) {
    const a = r * w + s, b = a + 1, c = a + w, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Equirect Milky Way: 0h RA at the centre, RA increasing to the left, +90° Dec on top. */
function celestialGeometry(radius, toLocal, rings = 64, slices = 128) {
  const pos = [], uv = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const v = r / rings, dec = (v - 0.5) * Math.PI;
    for (let s = 0; s <= slices; s++) {
      const u = s / slices, ra = (0.5 - u) * 2 * Math.PI;
      const d = equatorial(ra, dec).applyMatrix3(toLocal);
      pos.push(d.x * radius, d.y * radius, d.z * radius);
      uv.push(u, v);
    }
  }
  const w = slices + 1;
  for (let r = 0; r < rings; r++) for (let s = 0; s < slices; s++) {
    const a = r * w + s, b = a + 1, c = a + w, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Star colour from B−V, desaturated toward white the way stars look to the eye. */
function starColor(bv) {
  const t = (4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))) / 100;
  let r, g, b;
  if (t <= 66) { r = 1; g = Math.min(1, Math.max(0, 0.39008 * Math.log(t) - 0.63184)); }
  else { r = Math.min(1, 1.29294 * Math.pow(t - 60, -0.1332)); g = Math.min(1, 1.12989 * Math.pow(t - 60, -0.0755)); }
  if (t >= 66) b = 1; else if (t <= 19) b = 0; else b = Math.min(1, Math.max(0, 0.54321 * Math.log(t - 10) - 1.19625));
  return [1 + (r - 1) * 0.55, 1 + (g - 1) * 0.55, 1 + (b - 1) * 0.55];
}

const STAR_RADIUS = 385;
const starShader = {
  vertexShader: /* glsl */`
    attribute vec3 color; attribute float size; attribute vec2 corner;
    varying vec3 vColor; varying vec2 vCorner;
    void main() {
      vColor = color; vCorner = corner;
      vec3 d = normalize(position);
      vec3 ref = abs(d.y) < 0.95 ? vec3(0., 1., 0.) : vec3(1., 0., 0.);
      vec3 right = normalize(cross(ref, d)), up = cross(d, right);
      vec3 p = d * ${STAR_RADIUS.toFixed(1)} + (right * corner.x + up * corner.y) * size;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }`,
  fragmentShader: /* glsl */`
    uniform float opacity;
    varying vec3 vColor; varying vec2 vCorner;
    void main() {
      float r = length(vCorner);
      float core = exp(-r * r / (2. * .16 * .16));
      float a = min(1., (core + .22 * exp(-r / .28)) * max(0., 1. - r * r)) * opacity;
      vec3 c = mix(vColor, vec3(1.), min(1., core * 1.4) * .6);
      gl_FragColor = vec4(c, a);
    }`,
};

export class Sky {
  constructor(frame, date = new Date()) {
    this.root = new THREE.Group();
    this.root.name = 'sky';
    const toLocal = celestialToLocal(frame, date);
    const tl = new THREE.TextureLoader();
    const tex = (url, srgb = true) => { const t = tl.load(url); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };

    // Milky Way (opaque base: always behind everything)
    this.milkyWay = new THREE.Mesh(celestialGeometry(RADIUS, toLocal),
      new THREE.MeshBasicMaterial({ map: tex('assets/milkyway.jpg'), color: new THREE.Color(0.32, 0.32, 0.32), side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
    this.milkyWay.renderOrder = -100;

    // Stars: one camera-independent quad per star facing the centre.
    this.starMat = new THREE.ShaderMaterial({ ...starShader, uniforms: { opacity: { value: 0 } }, ...BACKGROUND_BLEND, side: THREE.DoubleSide });
    this.stars = new THREE.Mesh(new THREE.BufferGeometry(), this.starMat);
    this.stars.renderOrder = -99;
    this.stars.frustumCulled = false;
    fetch('assets/stars.bin').then((r) => r.arrayBuffer()).then((buf) => this.buildStars(new Float32Array(buf), toLocal));

    // Daylight haze gradient (zenith on top, horizon in the middle).
    const grad = tex('assets/sky_gradient.png');
    this.hazeMat = skyMaterial({ map: grad });
    this.haze = new THREE.Mesh(bandGeometry(RADIUS * 0.95, 24, 48), this.hazeMat);
    this.haze.renderOrder = -98;

    // Photographed sky with real cumulus, thinning out above the clouds.
    const day = tex('assets/daysky.jpg');
    day.generateMipmaps = true;
    this.dayMat = skyMaterial({ map: day });
    this.daySky = new THREE.Mesh(bandGeometry(RADIUS * 0.93, 48, 96, (-6 * Math.PI) / 180, CAP_FROM), this.dayMat);
    this.daySky.renderOrder = -97;
    this.capMat = skyMaterial({ map: tex('assets/daysky_cap.jpg') });
    const cap = new THREE.Mesh(zenithCapGeometry(RADIUS * 0.93), this.capMat);
    cap.renderOrder = -97;
    this.daySky.add(cap);

    // Sun: 24° sprite, 0.53° disc plus glow.
    this.sunMat = new THREE.SpriteMaterial({ map: sunTexture(), fog: false, ...BACKGROUND_BLEND });
    this.sun = new THREE.Sprite(this.sunMat);
    const sunR = 370, size = 2 * sunR * Math.tan((12 * Math.PI) / 180);
    this.sun.scale.set(size, size, 1);
    this.sun.position.copy(SUN_DIRECTION).multiplyScalar(sunR);
    this.sun.renderOrder = -96;

    this.root.add(this.milkyWay, this.stars, this.haze, this.daySky, this.sun);
    this.hazeBrightness = -1;
    this.update(0);
  }

  buildStars(recs, toLocal) {
    const n = recs.length / 4;
    const pos = new Float32Array(n * 4 * 3), col = new Float32Array(n * 4 * 3), size = new Float32Array(n * 4), corner = new Float32Array(n * 4 * 2);
    const idx = new Uint32Array(n * 6);
    const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let i = 0; i < n; i++) {
      const ra = recs[i * 4], dec = recs[i * 4 + 1], mag = recs[i * 4 + 2], bv = recs[i * 4 + 3];
      const d = equatorial(ra, dec).applyMatrix3(toLocal);
      const excess = Math.max(0, 6.5 - mag);
      const sizeDeg = 0.11 + 0.05 * Math.pow(excess, 1.2);
      const half = STAR_RADIUS * Math.tan((sizeDeg * Math.PI) / 360);
      const bright = 0.38 + 0.62 * Math.min(1, Math.max(0, (6.5 - mag) / 6.0));
      const c = starColor(bv);
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        pos.set([d.x, d.y, d.z], v * 3);
        col.set([c[0] * bright, c[1] * bright, c[2] * bright], v * 3);
        size[v] = half; corner.set(cs[k], v * 2);
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    const g = this.stars.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }

  /** Day fades to black between ~10 km and ~45 km; stars come out through it. */
  update(altitude) {
    const t = Math.min(1, Math.max(0, (altitude - 10_000) / 35_000));
    const day = (1 - t) * (1 - t);
    this.starMat.uniforms.opacity.value = 0.15 + 0.85 * t;
    this.hazeMat.opacity = Math.min(1, day * 2.2);
    this.haze.visible = this.hazeMat.opacity > 0.001;
    const b = Math.max(0, 1 - t * 1.15);
    if (Math.abs(b - this.hazeBrightness) > 0.01) {
      this.hazeBrightness = b;
      // Darkens toward deep navy, then black, as from a high-altitude balloon.
      const deep = [0.02, 0.05, 0.16], m = b * b;
      this.hazeMat.color.setRGB(deep[0] + (1 - deep[0]) * m, deep[1] + (1 - deep[1]) * m, deep[2] + (1 - deep[2]) * m, THREE.SRGBColorSpace);
    }
    const above = Math.min(1, Math.max(0, (altitude - 900) / 2600));
    const photo = 1 - smoothstep(above);
    this.dayMat.opacity = this.capMat.opacity = photo;
    this.daySky.visible = photo > 0.001;
  }
}

function sunTexture() {
  const n = 512, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d'), img = g.createImageData(n, n);
  const discR = 0.53 / 24;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = ((x + 0.5) / n) * 2 - 1, dy = ((y + 0.5) / n) * 2 - 1, r = Math.hypot(dx, dy);
    const disc = r < discR ? 1 : Math.max(0, 1 - (r - discR) / 0.004);
    const glow = 0.55 * Math.exp(-r / 0.035) + 0.22 * Math.exp(-r / 0.11) + 0.08 * Math.exp(-r / 0.32);
    const dither = (Math.random() + Math.random() - 1) / 255;
    const a = Math.min(1, Math.max(0, (disc + glow) * Math.max(0, 1 - r * r) + dither * 1.5));
    const w = Math.min(1, disc + glow * 0.5);
    const i = (y * n + x) * 4;
    img.data[i] = 255; img.data[i + 1] = (0.93 + 0.07 * w) * 255; img.data[i + 2] = (0.82 + 0.18 * w) * 255; img.data[i + 3] = a * 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
