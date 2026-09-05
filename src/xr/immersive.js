/**
 * Immersive view: the corridor around you, at human scale, through WebXR.
 *
 * Targets Apple Vision Pro (visionOS Safari exposes `immersive-vr` with
 * transient-pointer input: look at something, pinch, drag) but nothing here is
 * Apple-specific -- any immersive-vr browser gets the same session.
 *
 * WHAT CHANGES IN A HEADSET, and why:
 *   - The flat camera rig is bypassed. Its follow, growth dolly, counter-roll,
 *     FOV kicks and trauma shake are all camera motion the player did not make,
 *     and in a headset every one of those is a nausea source. The head IS the
 *     camera; this module only positions the floor it stands on.
 *   - The viewer stands on the road behind the squad (CFG.xr.standZ) on a low
 *     platform (standY), following the squad's x softly. The world still
 *     treadmills toward them at 14-18 u/s, so this is not a comfort-first mode;
 *     the platform height keeps the road out of the immediate periphery, which
 *     is where vection is felt most.
 *   - Steering is a pinch-drag: the input source's target ray is intersected
 *     with a vertical plane a couple of metres ahead, and its lateral travel is
 *     fed to the same Input accumulator the touch drag uses, in world units.
 *   - The DOM (HUD, start and end cards) is not visible inside a session, so a
 *     pinch on the title state deploys and a pinch after a run restarts. The
 *     squad count already lives in the world (view/labels.js).
 *
 * The camera is re-parented under `rig` for the session and handed back on
 * exit; three's WebXRManager writes the head pose into the camera relative to
 * its parent, so the rig transform is the whole viewpoint.
 */
import { Group, Vector3 } from 'three'
import { CFG } from '../config.js'

const STATE_READY = 0
const STATE_WON = 3
const STATE_LOST = 4

const _origin = new Vector3()
const _dir = new Vector3()

export function createImmersive({ renderer, scene, camera, world, input, onStart, onRestart, onEnter, onExit }) {
  const rig = new Group()
  rig.name = 'xr-rig'

  let session = null
  let refSpace = null
  let cameraParent = null
  let savedNear = camera.near
  let rigX = 0

  // One drag at a time: the source that is pinching, and where its ray last
  // crossed the drag plane (rig-local x).
  let dragSource = null
  let dragLastX = 0
  let dragHasLast = false

  async function supported() {
    try {
      if (typeof navigator === 'undefined' || !navigator.xr) return false
      return await navigator.xr.isSessionSupported('immersive-vr')
    } catch {
      return false
    }
  }

  async function enter() {
    if (session) return true
    if (!(await supported())) return false
    let s
    try {
      s = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'hand-tracking'],
      })
    } catch (err) {
      console.warn('immersive: session refused', err)
      return false
    }
    session = s
    renderer.xr.enabled = true
    session.addEventListener('end', onSessionEnd)
    session.addEventListener('selectstart', onSelectStart)
    session.addEventListener('selectend', onSelectEnd)
    session.addEventListener('select', onSelect)
    // local-floor puts the rig origin on the real floor so eye height is the
    // wearer's own; a runtime without it gets `local` (origin at the head at
    // session start), which is a standing viewer's eye height minus nothing --
    // standY then reads as a slightly taller platform, which is fine.
    let ok = false
    for (const space of ['local-floor', 'local']) {
      renderer.xr.setReferenceSpaceType(space)
      try {
        await renderer.xr.setSession(session)
        ok = true
        break
      } catch (err) {
        console.warn('immersive: reference space', space, 'refused', err)
      }
    }
    if (!ok) {
      session.removeEventListener('end', onSessionEnd)
      const dead = session
      session = null
      renderer.xr.enabled = false
      try { dead.end() } catch { /* already gone */ }
      return false
    }
    refSpace = renderer.xr.getReferenceSpace()

    // Take the camera under the rig. Its near plane is the flat game's 1u,
    // which would clip the platform under the viewer's own feet.
    cameraParent = camera.parent
    savedNear = camera.near
    camera.near = CFG.xr.near
    camera.updateProjectionMatrix()
    rigX = world.anchorX * CFG.xr.followFactor
    rig.position.set(rigX, CFG.xr.standY, CFG.xr.standZ)
    rig.rotation.set(0, 0, 0)
    if (cameraParent) cameraParent.remove(camera)
    rig.add(camera)
    scene.add(rig)
    if (onEnter) onEnter()
    return true
  }

  function exit() {
    if (session) session.end()
  }

  function onSessionEnd() {
    const s = session
    session = null
    refSpace = null
    dragSource = null
    dragHasLast = false
    if (s) {
      s.removeEventListener('end', onSessionEnd)
      s.removeEventListener('selectstart', onSelectStart)
      s.removeEventListener('selectend', onSelectEnd)
      s.removeEventListener('select', onSelect)
    }
    renderer.xr.enabled = false
    rig.remove(camera)
    scene.remove(rig)
    if (cameraParent) cameraParent.add(camera)
    camera.near = savedNear
    camera.updateProjectionMatrix()
    if (onExit) onExit()
  }

  function onSelectStart(e) {
    if (dragSource) return
    dragSource = e.inputSource
    dragHasLast = false
  }

  function onSelectEnd(e) {
    if (e.inputSource === dragSource) {
      dragSource = null
      dragHasLast = false
    }
  }

  /** A pinch with no drag behind it: deploy on the title, retry after a run. */
  function onSelect() {
    const st = world.state
    if (st === STATE_READY) { if (onStart) onStart() }
    else if (st === STATE_WON || st === STATE_LOST) { if (onRestart) onRestart() }
  }

  /**
   * Once per frame, INSIDE the session's animation callback (the game loop
   * runs there while presenting, see core/loop.js): read the pinching hand's
   * ray and turn its lateral travel across the drag plane into steering.
   */
  function poll() {
    if (!session || !dragSource || !refSpace) return
    const frame = renderer.xr.getFrame()
    if (!frame) return
    const pose = frame.getPose(dragSource.targetRaySpace, refSpace)
    if (!pose) return
    const t = pose.transform
    // Ray in reference space (rig-local: the rig IS the reference space origin).
    _origin.set(t.position.x, t.position.y, t.position.z)
    _dir.set(0, 0, -1).applyQuaternion(t.orientation)
    // Intersect with the vertical plane z = -dragPlaneZ in front of the viewer.
    const planeZ = -CFG.xr.dragPlaneZ
    if (_dir.z > -1e-4) return           // pointing sideways or backwards: no read
    const k = (planeZ - _origin.z) / _dir.z
    const x = _origin.x + _dir.x * k
    if (dragHasLast) input.pushWorldDx((x - dragLastX) * CFG.xr.dragGain)
    dragLastX = x
    dragHasLast = true
  }

  /** Per frame while presenting: the platform follows the squad sideways. */
  function sync(w, dt) {
    if (!session) return
    const c = CFG.xr
    const k = 1 - Math.exp(-dt / Math.max(1e-4, c.followTau))
    rigX += (w.anchorX * c.followFactor - rigX) * k
    rig.position.x = rigX
  }

  return {
    supported, enter, exit, poll, sync, rig,
    get presenting() { return session !== null },
  }
}
