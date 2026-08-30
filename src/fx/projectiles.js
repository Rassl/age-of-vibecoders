/**
 * The spitter's acid, in flight.
 *
 * rings.js paints a marker on the road under each shot because an arcing
 * projectile's ALTITUDE is unreadable at this camera pitch -- but the blob
 * itself still has to exist, or the only ranged threat in the game is an
 * invisible one that deletes a soldier with no visible cause.
 *
 * Read-only over sim state; the sim owns w.spits entirely.
 */
import {
  InstancedMesh, IcosahedronGeometry, MeshBasicMaterial, Matrix4, Color,
  AdditiveBlending, SRGBColorSpace,
} from 'three'
import { CFG } from '../config.js'

const ACID_CORE = new Color().setHex(0xc8ff6a, SRGBColorSpace)
const ACID_HALO = new Color().setHex(0x6aff9c, SRGBColorSpace)

// Module-scope scratch: nothing in sync() may allocate.
const m = new Matrix4()
const tint = new Color()

export function createProjectiles(scene) {
  const cap = CFG.pool.spits

  const coreGeo = new IcosahedronGeometry(0.19, 1)
  const haloGeo = new IcosahedronGeometry(0.34, 1)

  const coreMat = new MeshBasicMaterial({ toneMapped: false, fog: false })
  const haloMat = new MeshBasicMaterial({
    transparent: true, opacity: 0.42, blending: AdditiveBlending,
    depthWrite: false, toneMapped: false, fog: false,
  })

  const core = new InstancedMesh(coreGeo, coreMat, cap)
  const halo = new InstancedMesh(haloGeo, haloMat, cap)
  for (const mesh of [core, halo]) {
    // Matrices are written every frame, so three's bounding-sphere cull would
    // make every projectile vanish the moment the camera turns.
    mesh.frustumCulled = false
    mesh.count = 0
    scene.add(mesh)
  }
  core.renderOrder = 8
  halo.renderOrder = 7

  function sync(w, dt) {
    const pool = w.spits
    let n = 0
    for (let i = 0; i < pool.size; i++) {
      const s = pool.items[i]
      if (s.dead) continue

      // Wobble and spin so it reads as a thrown fluid mass rather than a bead.
      const wob = 1 + Math.sin(s.t * 22) * 0.14
      m.makeRotationY(s.t * 9)
      m.elements[0] *= wob; m.elements[5] *= 1 / wob; m.elements[10] *= wob
      m.elements[12] = s.x; m.elements[13] = s.y; m.elements[14] = s.z
      core.setMatrixAt(n, m)

      // The halo swells as it nears the squad plane: the last half second is
      // the part the player has to react to.
      const near = Math.min(1, Math.max(0, (s.z + 22) / 22))
      m.elements[0] *= 1 + near * 0.55
      m.elements[5] *= 1 + near * 0.55
      m.elements[10] *= 1 + near * 0.55
      halo.setMatrixAt(n, m)

      core.setColorAt(n, ACID_CORE)
      tint.copy(ACID_HALO).multiplyScalar(0.55 + near * 0.45)
      halo.setColorAt(n, tint)
      n++
      if (n >= cap) break
    }

    core.count = n
    halo.count = n
    core.instanceMatrix.needsUpdate = true
    halo.instanceMatrix.needsUpdate = true
    // instanceColor carries its OWN flag; bumping only the matrix freezes every
    // tint at its boot value while the positions animate correctly.
    if (core.instanceColor) core.instanceColor.needsUpdate = true
    if (halo.instanceColor) halo.instanceColor.needsUpdate = true
    core.visible = n > 0
    halo.visible = n > 0
  }

  function reset() {
    core.count = 0
    halo.count = 0
    core.visible = false
    halo.visible = false
  }

  function dispose() {
    scene.remove(core); scene.remove(halo)
    coreGeo.dispose(); haloGeo.dispose()
    coreMat.dispose(); haloMat.dispose()
  }

  return { sync, reset, dispose }
}
