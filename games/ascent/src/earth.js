// The Earth seen from above ~400 m (port of EarthRenderer.swift +
// EarthShader.metal). Instead of a compute pass into a cap texture, the same
// ray tracer runs per fragment on a small sphere around the eye, so each eye
// in the headset gets its own exact rays.
//
// Below ~3,000 km it is an overlay on the satellite tiles (night side, city
// lights, clouds, haze, the blue limb). Higher up it becomes the planet
// itself, from the NASA Blue Marble, Black Marble and cloud maps.

import * as THREE from 'three';
import { EARTH_RADIUS } from './geo.js';
import { SUN_DIRECTION, BACKGROUND_BLEND } from './sky.js';

const MIN_ASCENT = 400;

const vertexShader = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const fragmentShader = /* glsl */`
  precision highp float;
  uniform sampler2D dayTex, nightTex, cloudTex;
  uniform vec3 eyeKm;        // eye relative to Earth's centre, local-frame axes, km
  uniform mat3 toLocal;      // rendered-scene direction → local frame (undo the pitch)
  uniform mat3 toEcef;       // local frame → Earth-fixed (y polar)
  uniform vec3 sun;
  uniform vec4 params;       // x unused, y surface, z clouds, w atmosphere
  uniform vec4 params2;      // x radius km, z low haze
  uniform vec2 texSize;      // day texture size, px
  uniform float pixAngle;    // radians per screen pixel (approx.)
  varying vec3 vWorld;

  const float PI = 3.14159265;
  const vec3 kAtmo = vec3(0.30, 0.55, 1.00);
  const vec3 kSunset = vec3(1.00, 0.45, 0.18);
  vec3 limbColor(float sunDot) { return mix(kSunset, kAtmo, smoothstep(-0.04, 0.12, sunDot)); }

  void main() {
    float R = params2.x;
    float surfaceW = params.y, cloudW = params.z, atmoW = params.w;
    vec3 dir = normalize(toLocal * normalize(vWorld - cameraPosition));
    vec3 E = eyeKm;
    float t0 = -dot(E, dir);
    vec3 Pc = E + dir * t0;
    float dc = length(Pc);
    vec3 S = sun;

    if (t0 > 0.0 && dc < R) {
      float tHit = t0 - sqrt(max(0.0, R * R - dc * dc));
      vec3 P = E + dir * tHit;
      vec3 N = P / R;
      float mu = clamp(dot(-dir, N), 0.0, 1.0);
      float ndl = dot(N, S);

      vec3 g = toEcef * N;
      float lat = asin(clamp(g.y, -1.0, 1.0));
      float lon = atan(g.z, g.x);
      vec2 uv = vec2((lon + PI) / (2.0 * PI), 1.0 - (PI * 0.5 - lat) / PI);

      float groundKm = tHit * pixAngle / max(mu, 0.08);
      float texelsPerKm = texSize.x / (2.0 * PI * R);
      float lod = max(0.0, log2(groundKm * texelsPerKm));
      vec3 day = textureLod(dayTex, uv, lod).rgb;
      vec3 lights = textureLod(nightTex, uv, max(0.0, lod - 1.0)).rgb;
      float cloud = smoothstep(0.08, 0.95, textureLod(cloudTex, uv, lod).r);

      float light = smoothstep(-0.03, 0.22, ndl) * (0.28 + 0.72 * max(ndl, 0.0));
      float nightMask = 1.0 - smoothstep(-0.12, 0.06, ndl);
      lights = max(vec3(0.0), lights - 0.035) * 1.9 * nightMask;

      float rim = pow(1.0 - mu, 3.0);
      float scatter = smoothstep(-0.12, 0.30, ndl);
      vec3 hazeC = mix(limbColor(ndl), vec3(0.78, 0.86, 0.97), 0.35 * params2.z);
      float eyeAlt = max(length(E) - R, 0.01);
      const float Hs = 8.0;
      float avgDensity = Hs * (1.0 - exp(-eyeAlt / Hs)) / eyeAlt;
      float aerial = 1.0 - exp(-tHit * avgDensity / 160.0);
      float haze = min(0.9, aerial * 0.85 + 0.55 * rim) * scatter * atmoW;

      vec3 ground = day * light;
      vec3 cloudC = vec3(0.96, 0.97, 1.0) * light + vec3(0.01, 0.012, 0.02);
      vec3 planet = mix(ground, cloudC, cloud * 0.92);
      planet += lights * (1.0 - cloud * 0.75);
      float water = smoothstep(0.02, 0.10, day.b - max(day.r, day.g)) * (1.0 - cloud);
      vec3 refl = reflect(-S, N);
      float sp = max(dot(refl, -dir), 0.0);
      float glint = pow(sp, 90.0) * 0.9 + pow(sp, 12.0) * 0.08;
      planet += vec3(1.0, 0.96, 0.88) * glint * water * smoothstep(0.0, 0.2, ndl);
      planet = mix(planet, hazeC * (0.35 + 0.65 * scatter), haze);

      // Overlay over the tiles: night, clouds, lights and haze.
      float keep = 1.0;
      vec3 K = vec3(0.0);
      float nightA = (1.0 - smoothstep(-0.03, 0.22, ndl)) * 0.93;
      K *= (1.0 - nightA); keep *= (1.0 - nightA);
      float c = cloud * cloudW * 0.92;
      K = K * (1.0 - c) + cloudC * c; keep *= (1.0 - c);
      K += lights * (1.0 - cloud * 0.75);
      float h = haze * 0.9;
      K = K * (1.0 - h) + hazeC * (0.35 + 0.65 * scatter) * h; keep *= (1.0 - h);

      float A = mix(1.0 - keep, 1.0, surfaceW);
      vec3 Kf = mix(K, planet, surfaceW);
      vec3 C = A > 1e-4 ? Kf / A : vec3(0.0);
      gl_FragColor = vec4(min(C, vec3(4.0)), A);
    } else {
      float hgt = (t0 > 0.0) ? dc - R : length(E) - R;
      vec3 n = normalize(t0 > 0.0 ? Pc : E);
      float sd = dot(n, S);
      float lit = smoothstep(-0.10, 0.25, sd);
      float glow = (0.95 * exp(-hgt / 16.0) + 0.12 * exp(-hgt / 55.0)) * atmoW * lit;
      gl_FragColor = vec4(limbColor(sd), clamp(glow, 0.0, 1.0));
    }
    #include <colorspace_fragment>
  }`;

const ramp = (x, lo, hi) => { const t = Math.min(1, Math.max(0, (Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)))); return t * t * (3 - 2 * t); };

export class Earth {
  constructor(frame) {
    this.frame = frame;
    const tl = new THREE.TextureLoader();
    const load = (url, srgb) => {
      const t = tl.load(url);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
      return t;
    };
    const e = (v) => frame.toEcef(v);
    const ex = e([1, 0, 0]), ey = e([0, 1, 0]), ez = e([0, 0, 1]);
    this.material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms: {
        dayTex: { value: load('assets/earth_day.jpg', true) },
        nightTex: { value: load('assets/earth_night.jpg', true) },
        cloudTex: { value: load('assets/earth_clouds.jpg', false) },
        eyeKm: { value: new THREE.Vector3() },
        toLocal: { value: new THREE.Matrix3() },
        toEcef: { value: new THREE.Matrix3().set(ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2]) },
        sun: { value: SUN_DIRECTION.clone() },
        params: { value: new THREE.Vector4() },
        params2: { value: new THREE.Vector4(EARTH_RADIUS / 1000, 0, 0, 0) },
        texSize: { value: new THREE.Vector2(4096, 2048) },
        pixAngle: { value: (100 * Math.PI) / 180 / 2000 },
      },
      // Opaque pass, blended: after the tiles and buildings (renderOrder),
      // before labels and panels.
      ...BACKGROUND_BLEND, side: THREE.BackSide,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(8, 64, 32), this.material);
    this.mesh.renderOrder = 10;      // after tiles and buildings, before labels
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** `view`: { ascent, eyeLocal (the eye in the anchor frame, metres), qInv
   *  (scene → anchor-frame rotation) }; `eye` the head position in scene space. */
  update(view, eye) {
    const ascent = view.ascent;
    if (ascent <= MIN_ASCENT) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    this.mesh.position.copy(eye);
    const el = view.eyeLocal;
    const u = this.material.uniforms;
    u.eyeKm.value.set(el.x / 1000, (el.y + EARTH_RADIUS) / 1000, el.z / 1000);
    u.toLocal.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(view.qInv));
    u.params.value.set(0, ramp(ascent, 2_500_000, 7_000_000), ramp(ascent, 40_000, 600_000), ramp(ascent, 400, 2_500));
    u.params2.value.z = 1 - ramp(ascent, 20_000, 200_000);
  }

  planetOpaque(ascent) { return ascent > 7_000_000; }
}
