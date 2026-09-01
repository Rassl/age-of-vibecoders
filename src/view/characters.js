/**
 * Every body in the scene: the squad, its weapon, joiners in transit, five
 * kinds of horde, their corpses, and the boss.
 *
 * TEN DRAW CALLS. Eight InstancedMesh (soldiers, joiners, the shared weapon,
 * five enemy kinds), one for brute HP bars, one plain Mesh for the boss. Limbs
 * animate in the VERTEX SHADER off a per-instance phase -- there is no
 * InstancedSkinnedMesh in three, and 220 SkinnedMeshes is 220 draw calls plus a
 * bone texture each.
 *
 * WHY FIVE MESHES AND NOT ONE. Scale and tint cannot make a runner and a brute
 * different creatures; only geometry can. One InstancedMesh per kind costs four
 * extra draw calls out of a ~45 budget and buys five silhouettes, which is the
 * cheapest trade in the renderer. Each mesh is sized for the WHOLE zombie pool
 * plus corpses: a pool that overflows would drop an enemy that is still solid
 * to bullets, and an invisible wall is the worst bug this module could ship.
 *
 * WHY THE GUN IS ITS OWN MESH. It is parented to the right hand by construction
 * -- the gun geometry is authored in soldier model space and drawn with the
 * soldier's own instance matrix -- so swapping `mesh.geometry` on a tier-up
 * re-arms the entire squad in one assignment, with no per-soldier state and no
 * second material. The five gun geometries share one set of instanced
 * attributes so the swap keeps every per-instance value it already had.
 *
 * THE TWO-TIER RULE, which is the whole point of this module: gameplay position
 * (s.x, s.z) is INSTANT -- steer.js writes it before anything reads it, so the
 * bullets are already in the new lane on the frame you drag. What the player
 * SEES lags: every soldier damps toward its own gameplay position with a time
 * constant graded by how far out in the formation it sits, 0.09s at the core to
 * 0.20s at the rim. Identical taus give a rigid grid sliding around; the spread
 * is what turns forty rigid bodies into one fluid mass. The lag is purely
 * cosmetic and can never cost the player a hit.
 *
 * The view owns s.vx, s.vz, s.lean, s.recoil and s.recoilVel. No other sim
 * field is written here, ever. (combat.js kicks s.recoilVel on each shot and
 * never integrates it -- the spring lives here because it is pure feel.)
 */
import {
  Color, DynamicDrawUsage, Euler, InstancedBufferAttribute, InstancedMesh,
  Matrix4, Mesh, MeshBasicMaterial, MeshDepthMaterial, MeshLambertMaterial,
  PlaneGeometry, Quaternion, RGBADepthPacking, Vector2, Vector3,
} from 'three'
import { CFG } from '../config.js'
import { clamp } from '../util/math.js'
import { ENEMIES } from '../data/enemies.js'
import { WEAPONS } from '../data/weapons.js'
import {
  BOSS_RIG, ENEMY_RIGS, GUN_POSES, SOLDIER_RIG,
  buildBloaterGeometry, buildBossGeometry, buildBruteGeometry, buildGunGeometries,
  buildRunnerGeometry, buildSoldierGeometry, buildSpitterGeometry, buildWalkerGeometry,
} from './geometry.js'
import { createBossHead } from './bosshead.js'

/**
 * Set `LIMB_ANIM.enabled = false` BEFORE createCharacters() for the static
 * fallback: the pose function collapses to one line and the whole cast renders
 * as rigid bodies. Kept as a flag because a broken driver on the vertex-shader
 * path must not cost us the game.
 */
export const LIMB_ANIM = { enabled: true }

/** Turn off if the HP bar for `showHpBar` kinds is ever drawn elsewhere. */
export const BRUTE_HP_BAR = { enabled: true }

const TAU = Math.PI * 2

/** Mirrors STATE in sim/world.js. Duplicated on purpose: the view never imports from src/sim. */
const STATE_LOST = 4

const SOLDIER_GAIT_HZ = 2.55

/** Longest spring step we will ever integrate. omega*h stays under 1 -> stable. */
const MAX_SPRING_STEP = 0.033

/**
 * s.recoil peaks around 0.024 for a single shot -- an impulse of 1.0 through a
 * spring of omega 26. Multiplied straight into a rotation that is a fifth of a
 * degree, which is precisely why the old build's firing read as nothing at all.
 * Everything downstream works in DRIVE units instead: normalised so one shot is
 * ~0.4 and sustained fire sits near 1.
 */
const RECOIL_GAIN = 17

/** Order is the contract with KIND_AT / the crowds array, not with the sim. */
export const KINDS = ['walker', 'runner', 'brute', 'spitter', 'bloater']
const KIND_INDEX = { walker: 0, runner: 1, brute: 2, spitter: 3, bloater: 4 }

// Kinds differ in silhouette WEIGHT, never in hue: tint only nudges value so a
// brute reads as heavier and a runner as lighter under the same fog.
export const KIND_TINT = [
  [1.00, 1.00, 1.00],   // walker
  [1.10, 1.06, 0.90],   // runner
  [0.80, 0.86, 0.74],   // brute
  [0.98, 1.06, 0.86],   // spitter
  [1.05, 0.99, 0.92],   // bloater
]

/** Yaw wobble amplitude per kind. The bloater swings its whole mass. */
const KIND_YAW = [0.10, 0.05, 0.07, 0.04, 0.16]

/** Fallback lean if data/enemies.js ever drops a kind's `pitch`. */
const KIND_PITCH = [0.38, 0.50, 0.30, 0.30, 0.22]

/**
 * Gait tables. These are the whole animation design, so they live together
 * where they can be compared row against row rather than hunted for.
 *
 *   legAmpL/R  hip swing. UNEQUAL is a limp, and the walker's limp is the
 *              single cue that stops the crowd reading as marching soldiers.
 *   knee       shin fold on the return stride. Without it feet skate.
 *   bob/drop   vertical. `drop` fires on one step only: weight, not bounce.
 *              HARD LIMIT: bob + drop must stay under (1 - cos(legAmp)) * hipY,
 *              which is how far the leg swing lifts the foot. Past that the
 *              down beat drives the feet through the road -- and the heavier
 *              the kind, the more tempting the number and the worse it looks.
 *   roll/sway  side-to-side rock about the FEET. This is a waddle.
 *   torsoPitch upper-body nod at twice cadence.
 *   headRear   how far the head/neck swings on `aDrive` (spitter only).
 *   recoilP    upper-body pitch on `aDrive`.
 *
 * SIGN: recoilP, headRear and bodyKick are all POSITIVE = away from the body's
 * own facing, whichever way it faces -- the shader folds `face` in. A soldier
 * driven positive is shoved back by its own recoil; a spitter driven positive
 * rears back to spit, and goes NEGATIVE for the fifth of a second it is
 * whipping forward on the release.
 */
export const ANIM = {
  soldier: {
    legAmpL: 0.74, legAmpR: 0.74, knee: 0.85, armSwing: 0.05,
    headBob: 0.05, headOff: 0, headRear: 0,
    torsoPitch: 0.05, torsoOff: 0.8, bob: 0.05, drop: 0, sway: 0.014, roll: 0.022,
    recoilP: 0.15, dip: 0.13, bodyKick: 0.055, gunPitch: 0.44, gunKick: 0.14,
  },
  walker: {
    legAmpL: 0.54, legAmpR: 0.34, knee: 0.50, armSwing: 0.11,
    headBob: 0.13, headOff: 2.2, headRear: 0,
    torsoPitch: 0.07, torsoOff: 1.2, bob: 0.045, drop: 0.06, sway: 0.05, roll: 0.05,
    recoilP: 0, dip: 0, bodyKick: 0, gunPitch: 0, gunKick: 0,
  },
  runner: {
    legAmpL: 0.98, legAmpR: 0.98, knee: 1.20, armSwing: 0.66,
    headBob: 0.06, headOff: 0.4, headRear: 0,
    torsoPitch: 0.11, torsoOff: 0, bob: 0.075, drop: 0.02, sway: 0.02, roll: 0.035,
    recoilP: 0, dip: 0, bodyKick: 0, gunPitch: 0, gunKick: 0,
  },
  brute: {
    legAmpL: 0.60, legAmpR: 0.52, knee: 0.30, armSwing: 0.30,
    headBob: 0.05, headOff: 1.1, headRear: 0,
    torsoPitch: 0.05, torsoOff: 0.6, bob: 0.080, drop: 0.075, sway: 0.09, roll: 0.085,
    recoilP: 0, dip: 0, bodyKick: 0, gunPitch: 0, gunKick: 0,
  },
  spitter: {
    legAmpL: 0.46, legAmpR: 0.40, knee: 0.55, armSwing: 0.12,
    headBob: 0.16, headOff: 2.6, headRear: 1.30,
    torsoPitch: 0.06, torsoOff: 1.6, bob: 0.05, drop: 0.02, sway: 0.04, roll: 0.03,
    recoilP: 0.34, dip: 0, bodyKick: 0.10, gunPitch: 0, gunKick: 0,
  },
  bloater: {
    legAmpL: 0.44, legAmpR: 0.38, knee: 0.18, armSwing: 0.24,
    headBob: 0.09, headOff: 1.9, headRear: 0,
    torsoPitch: 0.04, torsoOff: 0.9, bob: 0.032, drop: 0.020, sway: 0.12, roll: 0.14,
    recoilP: 0, dip: 0, bodyKick: 0, gunPitch: 0, gunKick: 0,
  },
  boss: {
    legAmpL: 0.30, legAmpR: 0.30, knee: 0.16, armSwing: 0.22,
    headBob: 0.06, headOff: 1.1, headRear: 0,
    torsoPitch: 0.04, torsoOff: 0.5, bob: 0.16, drop: 0.10, sway: 0.10, roll: 0.045,
    recoilP: 0.13, dip: 0.05, bodyKick: 0.20, gunPitch: 0, gunKick: 0,
    lumpAmp: 0.07,
  },
}

const CORPSE_CAP = 40
const CORPSE_LIFE = 1.25
const BURST_LIFE = 0.30
const HP_BAR_CAP = 32

// ------------------------------------------------------------ module scratch
// Hoisted: sync() runs 400+ times a frame and must not allocate.
const _pos = new Vector3()
const _quat = new Quaternion()
const _euler = new Euler()
const _scl = new Vector3()
const _mtx = new Matrix4()
const _flash = new Color(0xffe9b0)
const _kindCount = new Int32Array(5)

const f = (x) => Number(x).toFixed(4)

/**
 * The gun's `extra` pose block: the barrel cluster spins about the bore, then
 * takes the same kick as the receiver so it cannot separate from the gun under
 * recoil. Exported (with enemyShaderOpts) so the dev gallery compiles the SAME
 * pose code as the game instead of a drifting copy.
 */
export const GUN_SPIN_EXTRA = `    vec3 ax = vec3(${f(SOLDIER_RIG.gunX)}, ${f(SOLDIER_RIG.gunY)}, 0.0);
    mat3 sp = rotZ(uSpin);
    mat3 kk = rotX(FW * ${f(ANIM.soldier.gunPitch)} * d);
    p = ax + kk * (sp * (p - ax));
    p.z += FW * ${f(ANIM.soldier.gunKick)} * d;
    rot = kk * sp;
    glow = 0.0;`

/** Per-kind charShader options (rim, and the bloater/spitter swell + glow). */
export function enemyShaderOpts(kind) {
  const rig = ENEMY_RIGS[kind]
  const opt = { key: kind, instanced: true, face: -1, rim: true }
  if (kind === 'bloater') {
    // Seams swell and glow with accumulated damage: a bloater about to pop is
    // visibly primed, which is the only way the blast can be a decision
    // rather than an ambush.
    opt.glow = [0.95, 0.36, 0.10]
    opt.extra = `    vec3 cc = vec3(0.0, ${f(rig.hipY + 0.40)}, 0.0);
    p = cc + (p - cc) * (1.0 + 0.05 * sin(ph * 2.3) + 0.22 * d);
    glow = clamp(0.18 + 0.85 * d + (0.10 + 0.35 * d) * sin(ph * 3.1), 0.0, 1.4);`
  } else if (kind === 'spitter') {
    opt.glow = [0.55, 0.85, 0.20]
    opt.extra = `    vec3 cc = vec3(0.0, ${f(rig.hipY + 0.20)}, 0.14);
    p = cc + (p - cc) * (1.0 + 0.03 * sin(ph * 1.7) + 0.26 * max(0.0, d));
    glow = 0.55 * max(0.0, d);`
  }
  return opt
}

/**
 * The character vertex/fragment injection, generated per material.
 *
 * `instanced` swaps the five per-body values between attributes and uniforms,
 * so the instanced crowd and the single boss mesh compile the SAME pose
 * function. `face` is +1 for anything facing -Z (the squad) and -1 for anything
 * walking INTO the camera; every pitch in the pose is multiplied by it, so one
 * table of positive amplitudes describes both directions of travel.
 */
export function charShader(mat, rig, anim, opt) {
  const decl = opt.instanced
    ? 'attribute float aPhase;\nattribute float aFlash;\nattribute float aDrive;\nattribute float aGait;\nattribute vec3 aTint;'
    : 'uniform float aPhase;\nuniform float aFlash;\nuniform float aDrive;\nuniform float aGait;\nuniform vec3 aTint;'

  // The support arm lies almost along +X, where a pitch about X would barely
  // move it, so the per-tier offset is applied on the axis each arm can
  // actually use: ROLL for the support arm, PITCH for the firing arm.
  const armRoll = opt.armPose ? '(side < 0.0 ? uArm.x : 0.0)' : '0.0'
  const armOff = opt.armPose ? '(side < 0.0 ? 0.0 : uArm.y)' : '0.0'

  const extra = opt.extra || '  glow = 0.0;'

  const pose = LIMB_ANIM.enabled ? `
void charPose() {
  float id = limbId;
  float ph = aPhase;
  float g = aGait;
  float d = aDrive;
  float sw = sin(ph);
  float FW = ${f(opt.face === -1 ? -1 : 1)};
  vec3 p = position;
  mat3 rot = mat3(1.0);
  float glow = 0.0;
  bool upper = true;
  vec3 hipP = vec3(0.0, ${f(rig.hipY)}, 0.0);

  if ((id > 3.5 && id < 5.5) || id > 7.5) {
    // Legs. Thighs are 4/5, shins 8/9; the shin folds about the knee FIRST and
    // is then carried by the thigh's swing, which is what a real chain does and
    // what stops the foot ploughing through the road on the return stride.
    upper = false;
    float side = (id < 4.5 || (id > 7.5 && id < 8.5)) ? -1.0 : 1.0;
    float psi = ph + (side > 0.0 ? 3.14159265 : 0.0);
    float amp = side < 0.0 ? ${f(anim.legAmpL)} : ${f(anim.legAmpR)};
    mat3 th = rotX(FW * amp * g * sin(psi));
    if (id > 7.5) {
      // Flexes from toe-off through early swing and is STRAIGHT again at heel
      // strike, which is what puts the foot on the road instead of through it.
      // (A knee that bends both ways reads as a broken leg, not a step.)
      float knee = -${f(anim.knee)} * g * max(0.0, sin(psi + 2.0));
      vec3 kp = vec3(side * ${f(rig.legX)}, ${f(rig.kneeY)}, 0.0);
      mat3 kn = rotX(FW * knee);
      p = kp + kn * (p - kp);
      rot = kn;
    }
    p = hipP + th * (p - hipP);
    rot = th * rot;
  } else if (id > 1.5 && id < 3.5) {
    float side = id < 2.5 ? -1.0 : 1.0;
    vec3 pv = vec3(side * ${f(rig.shoulderX)}, ${f(rig.shoulderY)}, 0.0);
    // Arms counter-swing against the same-side leg, then take the per-tier
    // offset that re-poses the whole squad when the weapon changes.
    mat3 m = rotZ(${armRoll}) * rotX(FW * (${f(anim.armSwing)} * g * sw * side) + ${armOff});
    p = pv + m * (p - pv);
    // The hands ride 55% of the weapon's kick. At 0% the gun tears out of the
    // grip on every shot; at 100% the kick stops reading as a kick at all.
    p.z += FW * ${f(anim.gunKick * 0.55)} * d;
    rot = m;
  } else if (id > 0.5 && id < 1.5) {
    vec3 pv = vec3(0.0, ${f(rig.neckY)}, 0.0);
    mat3 m = rotX(FW * (${f(anim.headBob)} * g * sin(ph * 2.0 + ${f(anim.headOff)})
                      + ${f(anim.headRear)} * d));
    p = pv + m * (p - pv);
    rot = m;
  } else if (id > 5.5 && id < 6.5) {
    vec3 pv = vec3(${f(rig.gunX)}, ${f(rig.gunY)}, 0.0);
    mat3 m = rotX(FW * ${f(anim.gunPitch)} * d);
    p = pv + m * (p - pv);
    p.z += FW * ${f(anim.gunKick)} * d;
    rot = m;
  } else if (id > 6.5 && id < 7.5) {
${extra}
  }

  if (upper) {
    // ONE rotation for everything above the hip. Pitching the torso alone
    // shears the head, pack and weapon off it the first time recoil fires.
    // The Z term drops the firing shoulder: a body absorbing a shot, not a
    // statue with a vibrating rifle.
    mat3 up = rotZ(-${f(anim.dip)} * d)
            * rotX(FW * (${f(anim.recoilP)} * d
                       + ${f(anim.torsoPitch)} * g * sin(ph * 2.0 + ${f(anim.torsoOff)})));
    p = hipP + up * (p - hipP);
    rot = up * rot;
  }

  // Whole-body, pivoted at the FEET: the weight transfer that makes a heavy
  // thing heavy. Everything below is translation, so normals are unaffected.
  mat3 rl = rotZ(${f(anim.roll)} * g * sw);
  p = rl * p;
  rot = rl * rot;
  // The pelvis drops further than the feet do, exactly as a real stride does.
  // At 1.0 on the legs the trailing toe is driven through the road on every
  // step; at 0.0 a gap opens at the hip. 0.4 hides inside the pelvis box.
  p.y -= (${f(anim.bob)} * abs(sw) + ${f(anim.drop)} * max(0.0, -sw)) * g
       * (upper ? 1.0 : 0.4);
  p.x += ${f(anim.sway)} * g * sin(ph * 0.5);
  p.z += FW * ${f(anim.bodyKick)} * d;

  charPos = p;
  charRot = rot;
  charGlow = glow;
}` : `
void charPose() { charRot = mat3(1.0); charPos = position; charGlow = 0.0; }`

  const vHead = `#include <common>
attribute float limbId;
${decl}${opt.lump ? '\nuniform float uTime;' : ''}${opt.spin ? '\nuniform float uSpin;' : ''}${opt.armPose ? '\nuniform vec2 uArm;' : ''}
varying float vFlash;
varying float vGlow;
mat3 charRot;
vec3 charPos;
float charGlow;
mat3 rotX(float ang) {
  float s = sin(ang);
  float c = cos(ang);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}
mat3 rotZ(float ang) {
  float s = sin(ang);
  float c = cos(ang);
  return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
}
${pose}`

  const lump = opt.lump ? `
  {
    float l = sin(position.y * 2.1 + uTime * 1.7) * sin(position.x * 1.7 - uTime * 1.1)
            + 0.5 * sin(position.z * 2.6 + uTime * 2.3);
    // Displace along a SMOOTH radial direction, never along the normal: this kit
    // is non-indexed boxes, so a normal-driven offset splits every seam open.
    transformed += normalize(vec3(position.x, 0.25, position.z)) * l * ${f(anim.lumpAmp || 0)};
  }` : ''

  const fresnel = `pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), ${f(opt.rimExp || 3.2)})`

  // Flash lands BEFORE tone mapping, in linear space, so it reads as light.
  const flashMix = opt.fresnelFlash
    ? `gl_FragColor.rgb = mix(gl_FragColor.rgb, FLASH_COLOR, clamp(vFlash * (0.30 + 0.70 * ${fresnel}), 0.0, 1.0));`
    : 'gl_FragColor.rgb = mix(gl_FragColor.rgb, FLASH_COLOR, vFlash);'

  // The rim and the seam glow go in AFTER fog on purpose. A pre-fog rim is
  // eaten by FogExp2 at exactly the distance where the horde needs to be
  // readable -- and a bloater that is about to detonate has to be readable
  // BEFORE it is close enough to matter.
  const glowCol = opt.glow || [0, 0, 0]
  const rim = opt.rim ? `
  gl_FragColor.rgb += vec3(0.878, 0.314, 0.247) * ${fresnel} * 0.55;` : ''
  const glow = opt.glow ? `
  gl_FragColor.rgb += vec3(${f(glowCol[0])}, ${f(glowCol[1])}, ${f(glowCol[2])}) * vGlow;` : ''

  mat.onBeforeCompile = (shader) => {
    if (opt.uniforms) {
      for (const k in opt.uniforms) shader.uniforms[k] = opt.uniforms[k]
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', vHead)
      .replace('#include <color_vertex>', '#include <color_vertex>\n  vColor.rgb *= aTint;\n  vFlash = aFlash;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  charPose();\n  objectNormal = charRot * objectNormal;')
      // charPose() has already run by begin_vertex, so vGlow is assigned here
      // rather than in color_vertex, which three emits FIRST.
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n  transformed = charPos;\n  vGlow = charGlow;${lump}`)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vFlash;\nvarying float vGlow;\nconst vec3 FLASH_COLOR = vec3(${f(_flash.r)}, ${f(_flash.g)}, ${f(_flash.b)});`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n  ${flashMix}`)
      .replace('#include <fog_fragment>', `#include <fog_fragment>${rim}${glow}`)
  }

  // Without a stable key three re-links a program per material per frame in some
  // builds, because the default key is the SOURCE of onBeforeCompile.
  const key = `char:${opt.key}:${LIMB_ANIM.enabled ? 1 : 0}`
  mat.customProgramCacheKey = () => key

  // The shadow pass renders through a MeshDepthMaterial, not through `mat`, so
  // the SAME pose injection goes into a depth twin -- without it every shadow is
  // a rest-pose statue sliding along under a running body. The twin shares the
  // caller's uniform OBJECTS (uArm, uSpin, uTime...), so surface and shadow can
  // never disagree about the pose. Attached via userData; makeCrowd wires it.
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking })
  depth.onBeforeCompile = (shader) => {
    if (opt.uniforms) {
      for (const k in opt.uniforms) shader.uniforms[k] = opt.uniforms[k]
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', vHead)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n  charPose();\n  transformed = charPos;${lump}`)
  }
  depth.customProgramCacheKey = () => `${key}:depth`
  mat.userData.depthMaterial = depth
  return mat
}

function instAttr(cap, size) {
  const a = new InstancedBufferAttribute(new Float32Array(cap * size), size)
  a.setUsage(DynamicDrawUsage)
  return a
}

function attachAttrs(geo, rec) {
  geo.setAttribute('aPhase', rec.aPhase)
  geo.setAttribute('aFlash', rec.aFlash)
  geo.setAttribute('aDrive', rec.aDrive)
  geo.setAttribute('aGait', rec.aGait)
  geo.setAttribute('aTint', rec.aTint)
}

function makeCrowd(geo, mat, cap) {
  const mesh = new InstancedMesh(geo, mat, cap)
  // three culls an InstancedMesh against the SOURCE geometry's bounding sphere
  // sitting at the mesh origin. Leave culling on and the entire horde blinks out
  // the moment the camera tilts -- silently, with no error anywhere.
  mesh.frustumCulled = false
  mesh.castShadow = true
  if (mat.userData.depthMaterial) mesh.customDepthMaterial = mat.userData.depthMaterial
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.count = 0

  const rec = {
    mesh,
    aPhase: instAttr(cap, 1),
    aFlash: instAttr(cap, 1),
    aDrive: instAttr(cap, 1),
    aGait: instAttr(cap, 1),
    aTint: instAttr(cap, 3),
  }
  attachAttrs(geo, rec)
  rec.phase = rec.aPhase.array
  rec.flash = rec.aFlash.array
  rec.drive = rec.aDrive.array
  rec.gait = rec.aGait.array
  rec.tint = rec.aTint.array
  return rec
}

/**
 * Publish one frame. Every instanced attribute needs its OWN needsUpdate: with
 * only instanceMatrix flagged the crowd slides around the corridor while gait,
 * flash and tint stay frozen at their boot values, and nothing warns you.
 */
function commit(rec, n) {
  rec.mesh.count = n
  rec.mesh.visible = n > 0
  rec.mesh.instanceMatrix.needsUpdate = true
  rec.aPhase.needsUpdate = true
  rec.aFlash.needsUpdate = true
  rec.aDrive.needsUpdate = true
  rec.aGait.needsUpdate = true
  rec.aTint.needsUpdate = true
}

/** Write one body into crowd `rec` at index `i`. Matrix is composed by the caller. */
function put(rec, i, phase, flash, drive, gait, r, g, b) {
  rec.phase[i] = phase
  rec.flash[i] = flash
  rec.drive[i] = drive
  rec.gait[i] = gait
  rec.tint[i * 3] = r
  rec.tint[i * 3 + 1] = g
  rec.tint[i * 3 + 2] = b
}

export function createCharacters(scene) {
  const soldierGeo = buildSoldierGeometry()
  const joinerGeo = soldierGeo.clone()
  const gunGeos = buildGunGeometries()
  const enemyGeos = [
    buildWalkerGeometry(), buildRunnerGeometry(), buildBruteGeometry(),
    buildSpitterGeometry(), buildBloaterGeometry(),
  ]
  const bossGeo = buildBossGeometry()

  // One vec2 shared by the squad and the joiners: x rolls the support arm, y
  // pitches the firing arm. The whole squad shares a tier, so this is the
  // entire per-tier pose state in the module.
  const armU = { uArm: { value: new Vector2(0, 0) } }

  const spinU = { uSpin: { value: 0 } }

  const soldierMat = charShader(
    new MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x101c28 }),
    SOLDIER_RIG, ANIM.soldier,
    { key: 'soldier', instanced: true, face: 1, armPose: true, uniforms: armU },
  )

  const joinerMat = charShader(
    new MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x101c28 }),
    SOLDIER_RIG, ANIM.soldier,
    { key: 'joiner', instanced: true, face: 1, armPose: true, uniforms: armU },
  )

  // The weapon rides the soldier's own pose: same rig, same gait constants, so
  // bob and recoil cannot drift a frame apart from the hands holding it.
  const gunMat = charShader(
    new MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x0c1016 }),
    SOLDIER_RIG, ANIM.soldier,
    { key: 'gun', instanced: true, face: 1, spin: true, uniforms: spinU, extra: GUN_SPIN_EXTRA },
  )

  const enemyMats = []
  for (let k = 0; k < KINDS.length; k++) {
    const kind = KINDS[k]
    enemyMats.push(charShader(
      new MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x161a12 }),
      ENEMY_RIGS[kind], ANIM[kind], enemyShaderOpts(kind),
    ))
  }

  const bossU = {
    aPhase: { value: 0 },
    aFlash: { value: 0 },
    aDrive: { value: 0 },
    aGait: { value: 1 },
    aTint: { value: new Color(1, 1, 1) },
    uTime: { value: 0 },
  }

  const bossMat = charShader(
    new MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x1a1020 }),
    BOSS_RIG, ANIM.boss,
    { key: 'boss', instanced: false, face: -1, lump: true, fresnelFlash: true, rimExp: 2.0, uniforms: bossU },
  )

  const soldiers = makeCrowd(soldierGeo, soldierMat, CFG.pool.soldiers)
  const joiners = makeCrowd(joinerGeo, joinerMat, CFG.pool.joiners)

  // One weapon mesh for the squad AND the joiners: joiner guns are simply
  // appended after the last soldier, so an incoming reinforcement is armed the
  // whole way in instead of materialising a rifle on arrival.
  const guns = makeCrowd(gunGeos[0], gunMat, CFG.pool.soldiers + CFG.pool.joiners)
  for (let i = 1; i < gunGeos.length; i++) attachAttrs(gunGeos[i], guns)

  // Sized for the WHOLE pool per kind. A wave that happens to be all bloaters
  // must not silently stop drawing bloaters.
  const ZCAP = CFG.pool.zombies + CORPSE_CAP
  const crowds = []
  for (let k = 0; k < KINDS.length; k++) crowds.push(makeCrowd(enemyGeos[k], enemyMats[k], ZCAP))

  const bars = makeHpBars(HP_BAR_CAP)

  const boss = new Mesh(bossGeo, bossMat)
  // A 7.2u boss is MEANT to overflow the frame. A bounds test on something that
  // surrounds the near plane is worthless, so skip it rather than risk a pop-out.
  boss.frustumCulled = false
  boss.castShadow = true
  boss.customDepthMaterial = bossMat.userData.depthMaterial
  boss.visible = false

  // The loaded head replaces the procedural ball the moment it arrives; until
  // then (or on a 404) the ball stands in, so the boss never fights headless.
  // Parented to the boss mesh: position/scale/topple are inherited, and only
  // the shader gait has to be mirrored (bosshead.js sync).
  const bossHead = createBossHead(BOSS_RIG, ANIM.boss, CFG.boss.headModelUrl, () => {
    boss.geometry.dispose()
    boss.geometry = buildBossGeometry(false)
  })
  boss.add(bossHead.group)

  scene.add(soldiers.mesh, joiners.mesh, guns.mesh, bars.mesh, boss)
  for (let k = 0; k < crowds.length; k++) scene.add(crowds[k].mesh)

  // ---- view-owned run state. Never read by the sim. ----
  const barQuat = new Quaternion()
  let clock = 0
  let dissolve = 0
  let bossRage = 0
  let bossFall = 0
  let tier = -1
  let spin = 0
  let spinRate = 0
  let firePower = 0

  // ---- corpse bookkeeping ------------------------------------------------
  // The sim reaps a zombie in the same step it dies, so by the time the view
  // runs there is nothing left to draw and no death list to read. Asking the
  // sim to hold corpses would put presentation state in a gameplay pool and
  // change every iteration bound in the file, so the view diffs the live set
  // itself: an id present last frame and absent now has just died, and its
  // pooled object still holds the position and pose it died in.
  const corpses = new Array(CORPSE_CAP)
  for (let i = 0; i < CORPSE_CAP; i++) {
    corpses[i] = { active: false, k: 0, x: 0, z: 0, scale: 1, phase: 0, t: 0, life: 1, side: 1, burst: false }
  }
  let corpseCursor = 0
  let trackItems = null
  let trackObj = null
  let trackSlot = null
  let liveCur = null
  let livePrev = null

  /**
   * Allocates ONCE, on the first frame, and never again -- the view only sees
   * the world in sync(), so there is no earlier moment to do it. Pool objects
   * are created up front and only ever reordered, so id -> slot is fixed for
   * the life of the process and survives every restart.
   */
  function bindTracker(pool) {
    if (trackItems === pool.items) return
    trackItems = pool.items
    const cap = pool.items.length
    trackObj = new Array(cap)
    trackSlot = new Map()
    for (let i = 0; i < cap; i++) {
      trackObj[i] = pool.items[i]
      trackSlot.set(pool.items[i].id, i)
    }
    liveCur = new Uint8Array(cap)
    livePrev = new Uint8Array(cap)
  }

  function spawnCorpse(z) {
    // A body that walked past the squad was despawned, not killed; a corpse
    // there would drop right under the camera for no reason.
    if (z.z > CFG.world.despawnZ - 0.5) return
    const c = corpses[corpseCursor]
    corpseCursor = (corpseCursor + 1) % CORPSE_CAP
    c.active = true
    c.k = KIND_INDEX[z.kind] !== undefined ? KIND_INDEX[z.kind] : 0
    c.x = z.x
    c.z = z.z
    c.scale = z.scale
    c.phase = z.phase * TAU
    c.t = 0
    c.burst = !!z.explodes
    c.life = c.burst ? BURST_LIFE : CORPSE_LIFE
    // Topple direction from the id parity: stable, free, and enough variety
    // that a row of kills does not fall like dominoes in step.
    c.side = (z.id & 1) ? 1 : -1
  }

  function makeHpBars(cap) {
    // A single quad per bar, coloured entirely in the fragment shader from a
    // per-instance fill: no texture, no glyph atlas, no runtime fillText.
    const geo = new PlaneGeometry(1, 0.13)
    const aFill = instAttr(cap, 1)
    geo.setAttribute('aFill', aFill)
    const mat = new MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false })
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aFill;\nvarying float vFill;\nvarying float vU;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFill = aFill;\n  vU = position.x + 0.5;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFill;\nvarying float vU;')
        .replace('#include <color_fragment>',
          '  diffuseColor.rgb = vU < vFill ? vec3(0.898, 0.282, 0.302) : vec3(0.086, 0.078, 0.078);')
    }
    mat.customProgramCacheKey = () => 'char:hpbar'
    const mesh = new InstancedMesh(geo, mat, cap)
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.count = 0
    return { mesh, geo, mat, aFill, fill: aFill.array }
  }

  // ------------------------------------------------------------- soldiers --

  function syncSoldiers(w, dt, step) {
    const pool = w.soldiers
    const items = pool.items
    const n = pool.size
    const fm = CFG.formation
    const tauF = fm.followTauFront
    const tauB = fm.followTauBack
    const denom = n > 1 ? n - 1 : 1
    const leanTarget = clamp(-w.anchorVelX * fm.leanGain, -0.45, 0.45)
    const gait = clock * SOLDIER_GAIT_HZ * TAU
    const iframe = CFG.squad.iframeSeconds

    // Underdamped ON PURPOSE (zeta 0.5): at 4+ shots/s it never settles, so the
    // whole formation permanently shudders. One float, more felt than any
    // particle system in the build -- but only once it is scaled into drive
    // units, which is what RECOIL_GAIN is for.
    const k = CFG.fx.recoilOmega * CFG.fx.recoilOmega
    const c = 2 * CFG.fx.recoilZeta * CFG.fx.recoilOmega

    const sy = 1 + (0.2 - 1) * dissolve
    const sxz = 1 + (1.4 - 1) * dissolve
    let peak = 0

    for (let i = 0; i < n; i++) {
      const s = items[i]

      // Slot index IS the phyllotaxis radius (r = spacing*sqrt(i)), so the front
      // of the crowd snaps and the rim trails without a single extra sqrt of x,z.
      const r01 = Math.sqrt(clamp(s.slot / denom, 0, 1))
      const kf = 1 - Math.exp(-dt / (tauF + (tauB - tauF) * r01))
      s.vx += (s.x - s.vx) * kf
      s.vz += (s.z - s.vz) * kf
      s.lean += (leanTarget - s.lean) * (1 - Math.exp(-dt / (0.06 + 0.10 * r01)))

      // Semi-implicit Euler on a clamped step: an alt-tabbed frame must not
      // detonate the spring into NaN and blank every soldier.
      s.recoilVel += (-k * s.recoil - c * s.recoilVel) * step
      s.recoil += s.recoilVel * step

      const drive = clamp(s.recoil * RECOIL_GAIN, -0.8, 1.3)
      if (drive > peak) peak = drive

      _pos.set(s.vx, 0, s.vz)
      _euler.set(0, 0, s.lean)
      _quat.setFromEuler(_euler)
      _scl.set(s.scale * sxz, s.scale * sy, s.scale * sxz)
      _mtx.compose(_pos, _quat, _scl)
      soldiers.mesh.setMatrixAt(i, _mtx)

      const phase = gait + s.phase * TAU
      const v = 0.90 + (s.scale - 0.96) * 2
      const fl = s.iframe > 0 ? 0.55 * (s.iframe / iframe) : 0
      put(soldiers, i, phase, fl, drive, 1 - dissolve, v, v, v)

      // The weapon IS the same body: same matrix, same index space, same phase,
      // same drive -- which is why it can never slide out of the hand.
      guns.mesh.setMatrixAt(i, _mtx)
      put(guns, i, phase, fl, drive, 1 - dissolve, 1, 1, 1)
    }
    commit(soldiers, n)

    // Smoothed so the barrels do not stutter between shots at low fire rates.
    firePower += (peak - firePower) * (1 - Math.exp(-dt / 0.10))
    return n
  }

  function syncJoiners(w, gunBase) {
    const pool = w.joiners
    const items = pool.items
    const gait = clock * SOLDIER_GAIT_HZ * TAU
    const tz = CFG.world.squadZ
    let n = 0
    for (let i = 0; i < pool.size; i++) {
      const j = items[i]
      if (j.dead || j.delay > 0) continue

      // Overshoot spring as a closed form of j.t: 0.2 -> ~1.15 -> 1.0. No stored
      // state, so a joiner swap-removed out from under us can never inherit
      // another joiner's half-finished pop.
      const pop = 1 - 0.8 * Math.exp(-6.4 * j.t) * Math.cos(12 * j.t)

      // The sim floats a joiner at y 0.9 and merges it on contact -- there is no
      // landing in the simulation at all. The view lands it: inside the last
      // 1.6u the body drops to the road and squashes, so the +1 arrives as a
      // footfall instead of a sprite winking out mid-air.
      const dx = w.anchorX - j.x
      const dz = tz - j.z
      const d = Math.sqrt(dx * dx + dz * dz)
      const land = 1 - clamp(d / 1.6, 0, 1)
      const y = j.y * (1 - land * land)
      const air = clamp(j.y / 0.9, 0, 1) * (1 - land)
      const sqY = pop * (1 + 0.28 * air - 0.30 * land)
      const sqXZ = pop * (1 - 0.12 * air + 0.20 * land)

      _pos.set(j.x, y, j.z)
      // Banked into the run-in, then upright the instant it touches down.
      _euler.set(0, 0, clamp(dx * 0.12, -0.3, 0.3) * (1 - land))
      _quat.setFromEuler(_euler)
      _scl.set(sqXZ, sqY, sqXZ)
      _mtx.compose(_pos, _quat, _scl)
      joiners.mesh.setMatrixAt(n, _mtx)
      put(joiners, n, gait + j.sx * 1.3, 0, 0, 1, 1.15, 1.15, 1.15)

      guns.mesh.setMatrixAt(gunBase + n, _mtx)
      put(guns, gunBase + n, gait + j.sx * 1.3, 0, 0, 1, 1.1, 1.1, 1.1)
      n++
    }
    commit(joiners, n)
    return n
  }

  // -------------------------------------------------------------- enemies --

  function syncZombies(w, dt) {
    const pool = w.zombies
    const items = pool.items
    bindTracker(pool)
    liveCur.fill(0)
    _kindCount[0] = 0; _kindCount[1] = 0; _kindCount[2] = 0
    _kindCount[3] = 0; _kindCount[4] = 0

    let barN = 0
    const n = pool.size

    for (let i = 0; i < n; i++) {
      const z = items[i]
      const slot = trackSlot.get(z.id)
      if (slot !== undefined) liveCur[slot] = 1

      const ki = KIND_INDEX[z.kind] !== undefined ? KIND_INDEX[z.kind] : 0
      const e = ENEMIES[z.kind]
      const rec = crowds[ki]
      const idx = _kindCount[ki]++
      const tint = KIND_TINT[ki]

      let pitch = e ? e.pitch : KIND_PITCH[ki]
      let drive = 0
      let gait = 1

      if (ki === 3) {
        // Spitter. It has to read as "not walking at me" before it fires, so
        // holding plants the legs and the rear-back runs the neck through the
        // biggest arc on the body -- then whips FORWARD (negative drive) on the
        // release and stays whipped for the first fifth of a second of reload.
        if (z.holding) {
          gait = 0.16
          const total = (e && e.windup) || 0.9
          if (z.windup > 0) {
            const charge = clamp(1 - z.windup / total, 0, 1)
            drive = charge < 0.78 ? charge / 0.78 : -0.9 * (charge - 0.78) / 0.22
          } else {
            const since = ((e && e.reload) || 2.4) - z.reload
            if (since >= 0 && since < 0.22) drive = -0.9 * (1 - since / 0.22)
          }
        }
        pitch -= 0.5 * drive
      } else if (ki === 4) {
        // Bloater: drive IS accumulated damage, so the seams light up and the
        // sac swells as it approaches detonation.
        drive = z.maxHp > 0 ? clamp(1 - z.hp / z.maxHp, 0, 1) : 0
      }

      _pos.set(z.x, 0, z.z)
      // POSITIVE pitch tips the top toward the camera: enemies walk INTO the
      // lens, so their forward lean is the opposite sign from the squad's.
      _euler.set(pitch, Math.sin(z.phase * 0.5) * KIND_YAW[ki], 0)
      _quat.setFromEuler(_euler)
      _scl.set(z.scale, z.scale, z.scale)
      _mtx.compose(_pos, _quat, _scl)
      rec.mesh.setMatrixAt(idx, _mtx)
      put(rec, idx, z.phase * TAU, z.flash > 1 ? 1 : z.flash, drive, gait,
        tint[0], tint[1], tint[2])

      if (BRUTE_HP_BAR.enabled && e && e.showHpBar && barN < HP_BAR_CAP && z.maxHp > 0) {
        barN = pushHpBar(z, ki, barN)
      }
    }

    // Diff against last frame: whatever was live and no longer is, just died.
    for (let s = 0; s < liveCur.length; s++) {
      if (livePrev[s] && !liveCur[s]) spawnCorpse(trackObj[s])
    }
    const swap = livePrev
    livePrev = liveCur
    liveCur = swap

    syncCorpses(dt)
    for (let k = 0; k < crowds.length; k++) commit(crowds[k], _kindCount[k])

    bars.mesh.count = barN
    bars.mesh.visible = barN > 0
    bars.mesh.instanceMatrix.needsUpdate = true
    bars.aFill.needsUpdate = true
  }

  function pushHpBar(z, ki, barN) {
    const rig = ENEMY_RIGS[KINDS[ki]]
    _pos.set(z.x, rig.height * z.scale + 0.34, z.z)
    _scl.set(1.05 * z.scale, 1.05 * z.scale, 1)
    _mtx.compose(_pos, barQuat, _scl)
    bars.mesh.setMatrixAt(barN, _mtx)
    bars.fill[barN] = clamp(z.hp / z.maxHp, 0, 1)
    return barN + 1
  }

  /**
   * Corpses. A body that vanishes on the frame it dies is the single cheapest
   * way to make a kill feel like nothing happened, so everything here exists to
   * spend a second of screen time on the death: the rig topples about its own
   * feet, settles, and sinks under the road rather than popping out. Bloaters
   * skip the topple and inflate instead -- their death is the blast, and the
   * body has to be gone by the time the particles land.
   */
  function syncCorpses(dt) {
    for (let i = 0; i < CORPSE_CAP; i++) {
      const c = corpses[i]
      if (!c.active) continue
      c.t += dt
      const u = c.t / c.life
      if (u >= 1) { c.active = false; continue }

      const rec = crowds[c.k]
      const idx = _kindCount[c.k]
      if (idx >= rec.mesh.instanceMatrix.count) continue
      _kindCount[c.k]++

      let sx = c.scale
      let sy = c.scale
      let y = 0
      if (c.burst) {
        // Swell, then collapse to nothing inside 0.3s.
        const s = u < 0.35 ? 1 + 1.15 * u : Math.max(0, 1.4 - (u - 0.35) * 4.3)
        sx = c.scale * s
        sy = c.scale * s
        _euler.set(0, 0, 0)
      } else {
        const fall = 1 - (1 - clamp(u / 0.45, 0, 1)) * (1 - clamp(u / 0.45, 0, 1))
        const settle = Math.exp(-6 * Math.max(0, u - 0.45)) * Math.sin(28 * Math.max(0, u - 0.45))
        const a = (1.52 + 0.10 * settle) * fall
        // Toppling SIDEWAYS keeps the body broadside to a camera looking down
        // the corridor, so the length of it stays legible as it goes down.
        _euler.set(0.30 * a, 0, a * c.side)
        const sink = clamp((u - 0.62) / 0.38, 0, 1)
        y = -0.55 * sink * sink
        sy = c.scale * (1 - 0.25 * sink)
      }
      _quat.setFromEuler(_euler)
      _pos.set(c.x, y, c.z)
      _scl.set(sx, sy, sx)
      _mtx.compose(_pos, _quat, _scl)
      rec.mesh.setMatrixAt(idx, _mtx)
      // Gait 0: a corpse has no cadence. Tinted down so the eye reads the live
      // crowd first even while three bodies are still folding in front of it.
      put(rec, idx, c.phase, 0, 0, 0, 0.72, 0.70, 0.68)
    }
  }

  // ----------------------------------------------------------------- boss --

  function syncBoss(w, dt) {
    const b = w.boss
    boss.visible = b.active
    if (!b.active) return

    bossRage += ((b.raging ? 1 : 0) - bossRage) * (1 - Math.exp(-dt / 0.6))
    bossFall += ((b.dead ? 1 : 0) - bossFall) * (1 - Math.exp(-dt / 0.55))

    // The rig is authored at BOSS_RIG.height; CFG.boss.height is the shipped
    // size, and it is deliberately large enough that the head crops out of frame.
    boss.scale.setScalar(CFG.boss.height / BOSS_RIG.height)
    boss.position.set(b.x, -3.4 * bossFall, b.z)
    // Falls TOWARD the camera, like everything else that walks at the squad.
    boss.rotation.set(0.85 * bossFall, 0, 0)

    bossU.aPhase.value = b.phase * TAU
    bossU.aFlash.value = b.flash > 1 ? 1 : b.flash
    bossU.aGait.value = 1 - bossFall
    // A broken plate buys a stagger; spend it as a visible rock backwards.
    bossU.aDrive.value = clamp(b.stagger / CFG.boss.plateStagger, 0, 1)
    bossU.uTime.value = clock
    bossU.aTint.value.setRGB(1 + bossRage * 0.35, 1 - bossRage * 0.12, 1 - bossRage * 0.08)

    bossHead.sync(bossU.aPhase.value, bossU.aGait.value, bossU.aDrive.value,
      bossU.aFlash.value, bossU.aTint.value)
  }

  // ---------------------------------------------------------------- weapon --

  function syncWeapon(w, dt) {
    const t = clamp(w.tier | 0, 0, gunGeos.length - 1)
    if (t !== tier) {
      tier = t
      guns.mesh.geometry = gunGeos[t]
      const pose = GUN_POSES[t]
      armU.uArm.value.set(pose.armL, pose.armR)
      spinRate = (WEAPONS[t] && WEAPONS[t].spin) || 0
    }
    // Spin-up and spin-down are what sell a rotary barrel; a cluster that snaps
    // to full speed reads as a texture scroll.
    spin += spinRate * clamp(firePower * 2.2, 0, 1) * dt
    if (spin > TAU) spin -= TAU * Math.floor(spin / TAU)
    spinU.uSpin.value = spin
  }

  return {
    /** `camera` is used only to billboard the HP bars. */
    sync(w, dt, camera) {
      const step = dt > MAX_SPRING_STEP ? MAX_SPRING_STEP : dt
      clock += dt
      // Dying soldiers DISSOLVE -- squash to 0.2 tall while spreading to 1.4 --
      // instead of ragdolling. A ragdoll needs per-body state that survives a
      // swap-remove, and the pool guarantees it will not.
      const target = w.state === STATE_LOST ? 1 : 0
      dissolve += (target - dissolve) * (1 - Math.exp(-dt / 0.45))
      if (camera && camera.isCamera) barQuat.copy(camera.quaternion)

      const nS = syncSoldiers(w, dt, step)
      const nJ = syncJoiners(w, nS)
      commit(guns, nS + nJ)
      syncWeapon(w, dt)
      syncZombies(w, dt)
      syncBoss(w, dt)
    },

    reset() {
      clock = 0
      dissolve = 0
      bossRage = 0
      bossFall = 0
      spin = 0
      firePower = 0
      tier = -1
      corpseCursor = 0
      for (let i = 0; i < CORPSE_CAP; i++) corpses[i].active = false
      // Without this the first frame of the new run reads every zombie of the
      // OLD run as having just died, and the restart opens on forty corpses.
      if (liveCur) { liveCur.fill(0); livePrev.fill(0) }
      soldiers.mesh.count = 0
      joiners.mesh.count = 0
      guns.mesh.count = 0
      bars.mesh.count = 0
      bars.mesh.visible = false
      for (let k = 0; k < crowds.length; k++) {
        crowds[k].mesh.count = 0
        crowds[k].mesh.visible = false
      }
      boss.visible = false
    },

    dispose() {
      scene.remove(soldiers.mesh, joiners.mesh, guns.mesh, bars.mesh, boss)
      soldiers.mesh.dispose()
      joiners.mesh.dispose()
      guns.mesh.dispose()
      bars.mesh.dispose()
      bars.geo.dispose()
      bars.mat.dispose()
      soldierGeo.dispose()
      joinerGeo.dispose()
      for (let i = 0; i < gunGeos.length; i++) gunGeos[i].dispose()
      for (let k = 0; k < crowds.length; k++) {
        scene.remove(crowds[k].mesh)
        crowds[k].mesh.dispose()
        enemyGeos[k].dispose()
        enemyMats[k].dispose()
      }
      // bossGeo may already have been swapped for the headless build; the mesh
      // always holds whichever one is live.
      boss.geometry.dispose()
      bossHead.dispose()
      soldierMat.dispose()
      joinerMat.dispose()
      gunMat.dispose()
      bossMat.dispose()
    },
  }
}
