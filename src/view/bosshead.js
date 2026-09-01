/**
 * The boss's head as a loaded GLTF model, mounted where the procedural ball
 * head sits (BOSS_HEAD_ANCHOR). The boss body animates in the VERTEX SHADER
 * (see charShader in characters.js), which a loaded mesh cannot join -- so this
 * module re-runs the head's slice of that pose function on the CPU each frame
 * and writes the result into the group's transform. One object, once a frame:
 * the duplication costs nothing, but the two copies of the math must agree or
 * the head visibly shears off the neck. If charPose() changes, change sync().
 *
 * Loading is fire-and-forget: until the fetch resolves (or if it 404s) the
 * boss keeps its procedural ball head, so a missing asset can never cost the
 * fight its boss.
 */
import { Box3, Color, Group, Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { BOSS_HEAD_ANCHOR } from './geometry.js'

/**
 * Eyeball knobs for fitting a particular model, applied after auto-centering
 * and auto-scaling. `scale` multiplies the auto fit (1 = the model's largest
 * dimension spans ~2.7x the old ball's diameter -- heads read too small at a
 * straight 1:1 swap under this camera). `yaw`/`pitch` fix a model exported
 * facing the wrong way: the boss walks INTO the camera, along +Z, which is
 * also the GLTF convention for "forward". Offsets are in rig units.
 */
const TUNE = { scale: 1, yaw: 0, pitch: 0, x: 0, y: 0, z: -0.15 }

/** How far the model's largest dimension spans, in ball-diameters. */
const FIT = 2.7

/** Mirrors _flash in characters.js: the shared hit-flash colour. */
const FLASH = new Color(0xffe9b0)

const X_AXIS = new Vector3(1, 0, 0)
const Z_AXIS = new Vector3(0, 0, 1)

// Faces -Z convention flag, same value charShader bakes in for the boss.
const FW = -1

const _p = new Vector3()
const _qHead = new Quaternion()
const _qUp = new Quaternion()
const _qX = new Quaternion()
const _qRoll = new Quaternion()

export function createBossHead(rig, anim, url, onReady) {
  const group = new Group()
  const disposables = []
  // { mat, baseColor, baseEmissive } per unique material: flash and rage are
  // shader effects on the body, mirrored here through color/emissive.
  const looks = []
  let loaded = false

  const loader = new GLTFLoader()
  // The shipped GLB is meshopt-compressed (EXT_meshopt_compression): 79MB of
  // source scan packs down to ~450KB, and the decoder is pure wasm -- no
  // external decoder files to serve.
  loader.setMeshoptDecoder(MeshoptDecoder)
  loader.load(url, (gltf) => {
    const model = gltf.scene

    const box = new Box3().setFromObject(model)
    const size = box.getSize(new Vector3())
    const center = box.getCenter(new Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    if (!(maxDim > 0)) return
    const s = (BOSS_HEAD_ANCHOR.r * 2 * FIT * TUNE.scale) / maxDim

    // group (posed by sync) -> spin (tune) -> pivot (centering) -> model.
    // The centering offset lives BELOW the tune rotation so yaw/pitch turn the
    // model about its own centre, not about wherever it was exported.
    const pivot = new Group()
    pivot.scale.setScalar(s)
    pivot.position.copy(center).multiplyScalar(-s)
    pivot.add(model)

    const spin = new Group()
    spin.rotation.set(TUNE.pitch, TUNE.yaw, 0)
    spin.position.set(TUNE.x, TUNE.y, TUNE.z)
    spin.add(pivot)
    group.add(spin)

    const seen = new Set()
    model.traverse((o) => {
      if (!o.isMesh) return
      o.castShadow = true
      // Same policy as the boss mesh: it is MEANT to overflow the frame.
      o.frustumCulled = false
      if (o.geometry) disposables.push(o.geometry)
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const mat of mats) {
        if (!mat || seen.has(mat)) continue
        seen.add(mat)
        disposables.push(mat)
        for (const k in mat) {
          if (mat[k] && mat[k].isTexture) disposables.push(mat[k])
        }
        if (mat.color && mat.emissive) {
          looks.push({ mat, baseColor: mat.color.clone(), baseEmissive: mat.emissive.clone() })
        }
      }
    })

    loaded = true
    if (onReady) onReady()
  }, undefined, (err) => {
    console.warn(`boss head model failed to load (${url}), keeping procedural head`, err)
  })

  return {
    group,

    get loaded() { return loaded },

    /**
     * Args are the boss material's uniform VALUES for this frame -- same
     * inputs charPose() reads, so body and head cannot drift apart.
     */
    sync(phase, gait, drive, flash, tint) {
      if (!loaded) return
      const a = BOSS_HEAD_ANCHOR
      const sw = Math.sin(phase)

      // Head nod about the neck pivot.
      _qHead.setFromAxisAngle(X_AXIS,
        FW * (anim.headBob * gait * Math.sin(phase * 2 + anim.headOff) + anim.headRear * drive))
      _p.set(a.x, a.y - rig.neckY, a.z).applyQuaternion(_qHead)
      _p.y += rig.neckY

      // One rotation for everything above the hip (recoil pitch + torso nod).
      _qUp.setFromAxisAngle(Z_AXIS, -anim.dip * drive).multiply(
        _qX.setFromAxisAngle(X_AXIS,
          FW * (anim.recoilP * drive + anim.torsoPitch * gait * Math.sin(phase * 2 + anim.torsoOff))))
      _p.y -= rig.hipY
      _p.applyQuaternion(_qUp)
      _p.y += rig.hipY

      // Whole-body roll about the feet, then the bob/sway/kick translations.
      _qRoll.setFromAxisAngle(Z_AXIS, anim.roll * gait * sw)
      _p.applyQuaternion(_qRoll)
      _p.y -= (anim.bob * Math.abs(sw) + anim.drop * Math.max(0, -sw)) * gait
      _p.x += anim.sway * gait * Math.sin(phase * 0.5)
      _p.z += FW * anim.bodyKick * drive

      group.position.copy(_p)
      group.quaternion.copy(_qRoll).multiply(_qUp).multiply(_qHead)

      // Rage tint scales the base colour; hit flash pushes emissive toward the
      // shared flash colour, approximating the body's fragment-stage mix.
      for (let i = 0; i < looks.length; i++) {
        const l = looks[i]
        l.mat.color.copy(l.baseColor).multiply(tint)
        l.mat.emissive.copy(l.baseEmissive).lerp(FLASH, flash > 1 ? 1 : flash)
      }
    },

    dispose() {
      for (const d of disposables) d.dispose()
      disposables.length = 0
      looks.length = 0
    },
  }
}
