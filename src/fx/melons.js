/**
 * The boss's slam, made PHYSICAL: a row of watermelons rolling down the road.
 *
 * The sim is untouched -- w.shockwaves still owns position, gap and the kill
 * test (sim/boss.js). This module only dresses each live shockwave as melons,
 * and rings.js keeps drawing the ground band underneath, because the band's
 * hard gap edges are the dodge read at 60u and fruit must never replace them.
 *
 * Melons lie long-axis ACROSS the corridor and roll without slipping: the spin
 * angle is z / radius, so the stripes visibly turn at exactly the speed the
 * row advances. Placement per wave is deterministic in melon index -- no
 * per-wave state, no allocation, the whole layout re-derives every frame from
 * the shockwave itself.
 */
import {
  BufferAttribute, Color, DynamicDrawUsage, InstancedMesh, Matrix4,
  MeshLambertMaterial, Quaternion, SphereGeometry, Vector3,
} from 'three'
import { CFG } from '../config.js'
import { clamp } from '../util/math.js'

/** Melon body radius; the long (X) semi-axis is R * MELON_STRETCH. */
const R = 0.55
const MELON_STRETCH = 1.35
const SPACING = 1.20
const MELONS_PER_WAVE = 8

const _mtx = new Matrix4()
const _pos = new Vector3()
const _quat = new Quaternion()
const _scl = new Vector3()
const _axis = new Vector3(1, 0, 0)

/** Cheap deterministic jitter, stable per melon slot. */
const jig = (i) => {
  const s = Math.sin(i * 12.9898) * 43758.5453
  return s - Math.floor(s)
}

/**
 * A striped watermelon, long axis along X. Stripes are vertex colours: dark
 * meridians over a mid-green rind, wobbled along X so they read as grown, not
 * printed. Exported for the dev gallery.
 */
export function buildWatermelonGeometry() {
  const g = new SphereGeometry(R, 16, 12).scale(MELON_STRETCH, 1, 1).toNonIndexed()
  const pos = g.attributes.position
  const n = pos.count
  const colors = new Float32Array(n * 3)
  const base = new Color(0x3f7d2c)
  const dark = new Color(0x1f4d18)
  const c = new Color()
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    // Meridian angle around the roll axis; 9 stripes, edges wobbled by x.
    const a = Math.atan2(z, y)
    const s = Math.sin(a * 9 + Math.sin(x * 6.0) * 0.55)
    c.copy(s > 0.15 ? base : dark)
    // Faint vertical shading so the top reads lit even in flat light.
    const k = 0.82 + 0.18 * clamp(y / R + 0.5, 0, 1)
    colors[i * 3] = c.r * k
    colors[i * 3 + 1] = c.g * k
    colors[i * 3 + 2] = c.b * k
  }
  g.setAttribute('color', new BufferAttribute(colors, 3))
  return g
}

export function createMelons(scene) {
  const CAP = CFG.pool.shockwaves * MELONS_PER_WAVE

  const geo = buildWatermelonGeometry()
  const mat = new MeshLambertMaterial({ vertexColors: true })
  const mesh = new InstancedMesh(geo, mat, CAP)
  mesh.frustumCulled = false
  mesh.castShadow = true
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.count = 0
  scene.add(mesh)

  function sync(w) {
    const railX = CFG.world.railX
    let n = 0

    const W = w.shockwaves
    for (let i = 0; i < W.size; i++) {
      const sw = W.items[i]
      if (sw.dead) continue
      // Gone once past the squad -- matches the band fade in rings.js, so the
      // fruit can never outlive the danger it stands for.
      if (sw.z > 6) continue
      const half = sw.gapW * 0.5
      // Throw-in pop: the row swells out of the slam instead of blinking on.
      const pop = clamp(sw.life * 7, 0.25, 1)

      // Both segments beside the gap, melons centred within each.
      for (let seg = 0; seg < 2; seg++) {
        const x0 = seg === 0 ? -railX : sw.gapX + half
        const x1 = seg === 0 ? sw.gapX - half : railX
        const wSeg = x1 - x0
        if (wSeg < R) continue
        const count = Math.max(1, Math.floor(wSeg / SPACING))
        const step = wSeg / count
        for (let k = 0; k < count && n < CAP; k++) {
          const slot = i * MELONS_PER_WAVE + seg * 4 + k
          const j = jig(slot)
          const x = x0 + step * (k + 0.5) + (j - 0.5) * 0.18
          // Roll without slipping, each melon offset so the row isn't in
          // lockstep; tiny hop keeps the row alive without lifting the danger
          // off the road.
          const angle = sw.z / R + j * Math.PI * 2
          const y = R * 0.96 * pop + Math.abs(Math.sin(angle * 0.5 + j * 6)) * 0.06
          _pos.set(x, y, sw.z)
          _quat.setFromAxisAngle(_axis, angle)
          _scl.setScalar(pop * (0.92 + j * 0.16))
          _mtx.compose(_pos, _quat, _scl)
          mesh.setMatrixAt(n, _mtx)
          n++
        }
      }
    }

    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
  }

  return {
    sync,
    reset() { mesh.count = 0 },
    dispose() {
      scene.remove(mesh)
      mesh.dispose()
      geo.dispose()
      mat.dispose()
    },
  }
}
