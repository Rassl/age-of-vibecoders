/**
 * The ground rings under every actor, plus the boss shockwave bands.
 *
 * THIS IS NOT DECORATION. In portrait the ground plane is nearly edge-on, so a
 * body's lateral position is almost unreadable from the body itself -- two
 * soldiers a full lane apart differ by a few pixels of silhouette. The rings are
 * simultaneously the lateral-position readout, the squad-count readout, the
 * visible hitbox and the contact shadow. Delete them and the mode is unplayable.
 *
 * DUAL LAYER, AND THE ORDER MATTERS: a dark contact ellipse UNDERNEATH an
 * additive glow ring. An additive-only ring adds light to the road and visually
 * floats off it; the dark ellipse is what welds the actor down.
 *
 * Everything flat here is coplanar with the road and relies on
 * polygonOffset(-1, -1) rather than a y-lift. A y-lift looks correct near the
 * camera and z-fights at the far end of the corridor -- which is exactly the
 * part of the screen the player is reading.
 */
import * as THREE from 'three'
import { CFG } from '../config.js'
import { ENEMIES } from '../data/enemies.js'
import { clamp } from '../util/math.js'

const TAU = Math.PI * 2

/** Soldier rings breathe in unison; a per-soldier phase reads as noise, not as a squad. */
const PULSE_HZ = 4

const DEATH_CAP = 32
const DEATH_LIFE = 0.4

// Expanding ground rings for explosions. Small on purpose: a barrel, a bloater
// and a boss slam can overlap, but a fourth simultaneous blast is a frame the
// player is not reading rings on anyway.
const SHOCKRING_CAP = 12

const SHOCK_BAND_Z = 1.4      // band depth along the corridor, before growth
const SHOCK_WALL_H = 1.15     // low enough to read as ground, tall enough to see from above

/**
 * Write a translation+scale matrix straight into an instance buffer. No
 * rotation is ever needed here -- both ring layers lie flat and the shockwave
 * wall stands square across the corridor -- so this is 16 stores instead of
 * Object3D.updateMatrix and its quaternion path.
 */
function setTRS(arr, i, x, y, z, sx, sy, sz) {
  const o = i * 16
  arr[o] = sx; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0
  arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0
  arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = sz; arr[o + 11] = 0
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1
}

/**
 * Baked once at boot. The shape lives entirely in the ALPHA channel with RGB
 * left white, so the sRGB transfer function on the colour map is a no-op and
 * the falloff cannot be silently gamma-warped.
 */
function bakeSprite(size, shape) {
  const data = new Uint8Array(size * size * 4)
  const inv = 1 / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) * inv - 0.5
      const dy = (y + 0.5) * inv - 0.5
      const a = shape(Math.sqrt(dx * dx + dy * dy))
      const o = (y * size + x) * 4
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255
      data[o + 3] = clamp(Math.round(a * 255), 0, 255)
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

/** Soft blob: a contact shadow, densest under the feet. */
function contactShape(d) {
  const t = clamp(1 - d / 0.5, 0, 1)
  return t * t * (3 - 2 * t)
}

/** Where the annulus peaks, as a fraction of the sprite's half-extent. */
const GLOW_PEAK = 0.36

/**
 * Per-kind ring look, flattened out of ENEMIES once at module load.
 *
 * `tone` is a VALUE-and-behaviour channel, not a hue channel: silhouette is what
 * separates the five bodies (view/geometry.js owns that), and the ring only
 * confirms it. The two entries that differ carry real information --
 *   bloater  throbs, because "this one is about to go off" has to be readable
 *            BEFORE it dies, and a body that is about to explode looks exactly
 *            like a fat walker from behind at 60u.
 *   spitter  holds a steady acid tint, because a stopped enemy in a crowd of
 *            advancing ones is otherwise invisible until the projectile is
 *            already in the air.
 * `radius` comes from the roster so that the visible hitbox and the sim's
 * collision radius can never drift apart.
 */
const RING_TONE = { normal: 0, throb: 1, acid: 2 }
const KIND_RING = new Map()
for (const id of Object.keys(ENEMIES)) {
  const e = ENEMIES[id]
  KIND_RING.set(id, {
    // ENEMIES.ringRadius already bakes in the body scale -- never multiply by
    // z.scale as well or a brute's ring lands 45% outside its own hitbox.
    radius: typeof e.ringRadius === 'number' ? e.ringRadius : CFG.fx.ringRadius.zombie,
    tone: e.explodes ? RING_TONE.throb : e.ranged ? RING_TONE.acid : RING_TONE.normal,
  })
}

/** Annulus with a faint inner wash, hard-cut at the quad edge so no seam shows. */
function glowShape(d) {
  const k = (d - GLOW_PEAK) / 0.085
  const g = Math.exp(-k * k)
  const inner = clamp(1 - d / GLOW_PEAK, 0, 1)
  return Math.min(1, g + 0.07 * inner * inner) * clamp((0.5 - d) / 0.07, 0, 1)
}

/** Unit quad lying in the road plane. */
function flatQuad() {
  const g = new THREE.PlaneGeometry(1, 1)
  g.rotateX(-Math.PI / 2)
  return g
}

/**
 * Per-vertex alpha down the four rows of a 1x3 plane. Cheaper and sharper than a
 * texture for the shockwave: the fade must exist along ONE axis only, and the
 * gap edges across the corridor have to stay perfectly hard.
 */
function rowAlpha(g, a0, a1, a2, a3) {
  const n = g.attributes.position.count
  const c = new Float32Array(n * 4)
  const rows = [a0, a1, a2, a3]
  for (let i = 0; i < n; i++) {
    const o = i * 4
    c[o] = 1; c[o + 1] = 1; c[o + 2] = 1
    c[o + 3] = rows[i >> 1]
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 4))
  return g
}

export function createRings(scene) {
  const CAP = CFG.pool.rings
  const SHOCK_CAP = CFG.pool.shockwaves * 2   // two segments per wave, one per side of the gap

  const col = new THREE.Color()
  col.setHex(0x4fc3f7, THREE.SRGBColorSpace)
  const CY_R = col.r, CY_G = col.g, CY_B = col.b
  col.setHex(0xe5484d, THREE.SRGBColorSpace)
  const RD_R = col.r, RD_G = col.g, RD_B = col.b
  col.setHex(0xff5a3c, THREE.SRGBColorSpace)
  const SH_R = col.r, SH_G = col.g, SH_B = col.b
  // AMBER for the bloater, ACID GREEN for the spitter. Two greens read as one
  // category at 60u through fog, and these two enemies demand opposite
  // responses -- kill the bloater early, get out of the spitter's lane -- so the
  // ring has to separate them at a glance. Amber is also the universal "about to
  // go off", and it is nowhere near the barrel's red.
  col.setHex(0xffc23a, THREE.SRGBColorSpace)
  const TX_R = col.r, TX_G = col.g, TX_B = col.b
  col.setHex(0x86e03c, THREE.SRGBColorSpace)
  const AC_R = col.r, AC_G = col.g, AC_B = col.b
  col.setHex(0x74e02a, THREE.SRGBColorSpace)
  const GN_R = col.r, GN_G = col.g, GN_B = col.b

  const contactTex = bakeSprite(64, contactShape)
  const glowTex = bakeSprite(64, glowShape)

  const darkMat = new THREE.MeshBasicMaterial({
    map: contactTex,
    color: 0x1a1611,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  // fog off on every additive layer: FogExp2 mixes toward the sand fog colour,
  // which BRIGHTENS a distant glow into mush instead of fading it. These rings
  // are the readout, so they keep full contrast the length of the corridor.
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  const bandMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  const wallMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  // Separate geometry objects per mesh: the two ring layers differ only in
  // texture today, and sharing one geometry is the kind of coupling that breaks
  // silently the first time either mesh needs its own attribute.
  const darkGeo = flatQuad()
  const glowGeo = flatQuad()
  const bandGeo = rowAlpha(
    new THREE.PlaneGeometry(1, 1, 1, 3).rotateX(-Math.PI / 2), 0, 1, 1, 0
  )
  // Origin at the base so the instance's Y scale is simply the wall height.
  const wallGeo = rowAlpha(
    new THREE.PlaneGeometry(1, 1, 1, 3).translate(0, 0.5, 0), 0, 0.28, 0.7, 1
  )

  const darkMesh = new THREE.InstancedMesh(darkGeo, darkMat, CAP)
  const glowMesh = new THREE.InstancedMesh(glowGeo, glowMat, CAP)
  const bandMesh = new THREE.InstancedMesh(bandGeo, bandMat, SHOCK_CAP)
  const wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, SHOCK_CAP)

  // Dark first, then glow on top of it, then the hazard. All four write no
  // depth, so submission order is the only thing that decides the stack.
  darkMesh.renderOrder = 2
  glowMesh.renderOrder = 3
  bandMesh.renderOrder = 4
  wallMesh.renderOrder = 5

  const meshes = [darkMesh, glowMesh, bandMesh, wallMesh]
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i]
    // three culls an InstancedMesh against its geometry bounding sphere sitting
    // at the MESH origin, so every ring in the game vanishes at once the moment
    // the camera turns slightly -- with no error anywhere.
    m.frustumCulled = false
    m.count = 0
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    scene.add(m)
  }

  // instanceColor is vec3, so for the additive layers per-instance BRIGHTNESS is
  // per-instance alpha -- which is why every fade in this file is a colour
  // scale. The dark layer needs no such control and carries no instanceColor.
  glowMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3).fill(1), 3)
  bandMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SHOCK_CAP * 3).fill(1), 3)
  wallMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SHOCK_CAP * 3).fill(1), 3)
  glowMesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
  bandMesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
  wallMesh.instanceColor.setUsage(THREE.DynamicDrawUsage)

  const darkM = darkMesh.instanceMatrix.array
  const glowM = glowMesh.instanceMatrix.array
  const glowC = glowMesh.instanceColor.array
  const bandM = bandMesh.instanceMatrix.array
  const bandC = bandMesh.instanceColor.array
  const wallM = wallMesh.instanceMatrix.array
  const wallC = wallMesh.instanceColor.array

  // Frozen death markers, as a ring buffer: a soldier lost from a crowd of forty
  // is 2.5% of the mass and otherwise completely invisible.
  const deathX = new Float32Array(DEATH_CAP)
  const deathZ = new Float32Array(DEATH_CAP)
  const deathT = new Float32Array(DEATH_CAP).fill(-1)
  let deathCur = 0

  // Expanding blast rings, same ring-buffer discipline as the death markers.
  // They ride the SAME glow instanced mesh as every other ring in the file, so
  // the whole feature costs zero extra draw calls -- which is the only reason a
  // scene with a 45-call budget can afford a shockwave on every explosion.
  const srX = new Float32Array(SHOCKRING_CAP)
  const srZ = new Float32Array(SHOCKRING_CAP)
  const srR0 = new Float32Array(SHOCKRING_CAP)
  const srR1 = new Float32Array(SHOCKRING_CAP)
  const srLife = new Float32Array(SHOCKRING_CAP)
  const srT = new Float32Array(SHOCKRING_CAP).fill(-1)
  const srTone = new Uint8Array(SHOCKRING_CAP)
  let srCur = 0

  let nDark = 0
  let nGlow = 0
  let nShock = 0

  function pushGlow(x, z, r, cr, cg, cb) {
    if (nGlow >= CAP) return
    // The bright band sits at GLOW_PEAK of the sprite's half-extent, so the quad
    // has to be oversized for the ring to actually land on the radius asked for.
    // Scaling by 2r instead puts every hitbox ring 28% inside its own hitbox.
    const d = r / GLOW_PEAK
    setTRS(glowM, nGlow, x, 0, z, d, 1, d)
    const o = nGlow * 3
    glowC[o] = cr; glowC[o + 1] = cg; glowC[o + 2] = cb
    nGlow++
  }

  function pushContact(x, z, r) {
    if (nDark >= CAP) return
    // Slightly wider than the glow so the shadow reads as the thing the ring
    // sits on rather than a second ring.
    const d = r * 2.24
    setTRS(darkM, nDark, x, 0, z, d, 1, d)
    nDark++
  }

  /**
   * One side of a shockwave: a ground band plus the low light wall above it.
   * Both instances share an index, so the wall can never drift out of sync with
   * the band that defines the gap.
   */
  function pushShock(x0, x1, z, grow, inten) {
    const w = x1 - x0
    if (w < 0.06 || nShock >= SHOCK_CAP) return
    const cx = (x0 + x1) * 0.5
    setTRS(bandM, nShock, cx, 0, z, w, 1, SHOCK_BAND_Z + grow * 0.5)
    setTRS(wallM, nShock, cx, 0, z, w, SHOCK_WALL_H, 1)
    const o = nShock * 3
    const b = inten * 1.3
    bandC[o] = SH_R * b; bandC[o + 1] = SH_G * b; bandC[o + 2] = SH_B * b
    const v = inten * 0.85
    wallC[o] = SH_R * v; wallC[o + 1] = SH_G * v; wallC[o + 2] = SH_B * v
    nShock++
  }

  function sync(w, dt) {
    const fx = CFG.fx
    const rSoldier = fx.ringRadius.soldier
    const rZombie = fx.ringRadius.zombie
    // rBrute is gone: per-kind radii now come from ENEMIES via KIND_RING, so a
    // sixth enemy cannot ship with a ring that silently defaults to walker size.
    const rBoss = fx.ringRadius.boss
    const railX = CFG.world.railX
    const pulse = 0.80 + 0.20 * Math.sin(w.runTime * PULSE_HZ * TAU)

    nDark = 0
    nGlow = 0
    nShock = 0

    const S = w.soldiers
    for (let i = 0; i < S.size; i++) {
      const s = S.items[i]
      // characters.js owns s.vx/s.vz: the visual springs that LAG the gameplay
      // slot. The ring is the visible hitbox, so it has to sit under the BODY --
      // a ring that leads the crowd reads as the game cheating. Both are exactly
      // zero until the springs have ticked once, hence the boot-frame fallback.
      const sprung = s.vx !== 0 || s.vz !== 0
      const x = sprung ? s.vx : s.x
      const z = sprung ? s.vz : s.z
      const r = rSoldier * s.scale
      // i-frames are otherwise invisible, and "why did that not kill me" is the
      // single most confusing moment in the mode.
      const inten = s.iframe > 0
        ? ((s.iframe * 22) % 2 < 1 ? 1.55 : 0.35)
        : pulse
      pushContact(x, z, r)
      pushGlow(x, z, r, CY_R * inten, CY_G * inten, CY_B * inten)
    }

    const b = w.boss
    if (b.active && !b.dead) {
      const rage = b.raging ? 1.0 + 0.3 * Math.sin(w.runTime * 7) : 1.0
      const inten = (1.05 + b.flash * 0.8) * rage
      pushContact(b.x, b.z, rBoss)
      pushGlow(b.x, b.z, rBoss, RD_R * inten, RD_G * inten, RD_B * inten)
    }

    for (let i = 0; i < DEATH_CAP; i++) {
      const t = deathT[i]
      if (t < 0) continue
      const t2 = t + dt
      if (t2 >= DEATH_LIFE) { deathT[i] = -1; continue }
      deathT[i] = t2
      const u = t2 / DEATH_LIFE
      // Glow only, no contact ellipse: there is no body left to weld down.
      // It holds full brightness for most of its life and then goes, so a loss
      // during a firefight cannot be missed in a single glance.
      const inten = 1.9 * Math.min(1, (1 - u) * 2.2)
      pushGlow(deathX[i], deathZ[i], rSoldier * (1 + u * 0.5),
        RD_R * inten, RD_G * inten, RD_B * inten)
    }

    // A bloater's throb runs off run time, not a per-body phase: the whole point
    // is that every volatile body on screen pulses IN UNISON, so the pattern
    // reads as a category rather than as one twitchy zombie.
    const throb = 0.72 + 0.62 * Math.abs(Math.sin(w.runTime * 5.5))

    const Z = w.zombies
    for (let i = 0; i < Z.size; i++) {
      const zb = Z.items[i]
      if (zb.dead) continue
      const look = KIND_RING.get(zb.kind)
      const r = look ? look.radius : rZombie
      let inten = 0.85 + zb.flash * 0.9
      const age = w.runTime - zb.spawnT
      if (age < 0.25) inten *= clamp(age * 4, 0, 1)
      const tone = look ? look.tone : RING_TONE.normal
      if (tone === RING_TONE.throb) {
        const k = inten * throb
        pushContact(zb.x, zb.z, r)
        pushGlow(zb.x, zb.z, r, TX_R * k, TX_G * k, TX_B * k)
      } else if (tone === RING_TONE.acid) {
        // Brighter while it is actually holding station and winding up -- the
        // windup is the only warning the player gets, and it has to be visible
        // from behind a crowd.
        const k = inten * (zb.holding ? 1.55 : 1.0)
        pushContact(zb.x, zb.z, r)
        pushGlow(zb.x, zb.z, r, AC_R * k, AC_G * k, AC_B * k)
      } else {
        pushContact(zb.x, zb.z, r)
        pushGlow(zb.x, zb.z, r, RD_R * inten, RD_G * inten, RD_B * inten)
      }
    }

    // Acid in flight. A marker on the ROAD, not just a body in the air: at this
    // camera pitch an arcing projectile's altitude is unreadable, so the only
    // way to know where it is coming down is to draw where it is coming down.
    const SP = w.spits
    if (SP) {
      for (let i = 0; i < SP.size; i++) {
        const sp = SP.items[i]
        if (sp.dead) continue
        const k = 1.35 + 0.5 * Math.sin(w.runTime * 22)
        pushGlow(sp.x, sp.z, CFG.zombie.spitRadius * 0.55, AC_R * k, AC_G * k, AC_B * k)
      }
    }

    // Blast rings last, so they sit on top of the body rings they are erasing.
    for (let i = 0; i < SHOCKRING_CAP; i++) {
      const t = srT[i]
      if (t < 0) continue
      const t2 = t + dt
      if (t2 >= srLife[i]) { srT[i] = -1; continue }
      srT[i] = t2
      srZ[i] += w.scroll * dt      // it is a mark on the road; the road is moving
      const u = t2 / srLife[i]
      // Ease OUT: a blast front is fastest at the instant it forms. A linear
      // expansion reads as an animation playing rather than as energy leaving.
      const rad = srR0[i] + (srR1[i] - srR0[i]) * (1 - (1 - u) * (1 - u))
      const rem = 1 - u
      // 1.15, not 2.4. The glow sprite's annulus thickness scales WITH radius,
      // so a 4u ring is already a ~1u-thick band; overdriving it on top of that
      // saturates through the tone map into a solid disc and the expansion --
      // the only part carrying information -- becomes invisible.
      const inten = 1.15 * rem * rem
      let cr = SH_R, cg = SH_G, cb = SH_B
      // Tone 1 is the bloater's PAYLOAD, which is toxic green -- not the amber
      // of its warning ring. Amber says "about to blow", green says "it did".
      if (srTone[i] === 1) { cr = GN_R; cg = GN_G; cb = GN_B }
      else if (srTone[i] === 2) { cr = CY_R; cg = CY_G; cb = CY_B }
      pushGlow(srX[i], srZ[i], rad, cr * inten, cg * inten, cb * inten)
      // The same fake-bloom trick the tracers use: a wider, dimmer twin. One
      // extra instance in a mesh that is already bound beats any blur pass.
      const halo = inten * 0.22
      pushGlow(srX[i], srZ[i], rad * 1.35, cr * halo, cg * halo, cb * halo)
    }

    const J = w.joiners
    for (let i = 0; i < J.size; i++) {
      const j = J.items[i]
      // characters.js skips joiners still inside their spawn stagger, so drawing
      // their ring here would leave a shadow on the road with nothing above it.
      if (j.dead || j.delay > 0) continue
      // A joiner arcs through the air; its shadow tightens and dims as it lands,
      // which is the only cue for where the reward is actually going to arrive.
      const h = 1 / (1 + (j.y > 0 ? j.y : 0) * 0.5)
      const r = rSoldier * (0.7 + 0.3 * h)
      pushContact(j.x, j.z, r * h)
      pushGlow(j.x, j.z, r, CY_R * h, CY_G * h, CY_B * h)
    }

    const W = w.shockwaves
    for (let i = 0; i < W.size; i++) {
      const sw = W.items[i]
      if (sw.dead) continue
      // Full strength everywhere the squad can still be hit; it only dims once
      // it is behind them and can no longer matter.
      let inten = Math.min(1, sw.life * 12) * (1 - clamp((sw.z - 3) / 9, 0, 1))
      if (inten <= 0.004) continue
      const half = sw.gapW * 0.5
      // Two bands with a hole between them, never one band with a painted gap:
      // the gap IS the dodge, so its edges must be geometry, not a texture that
      // blurs at distance and turns the read into a guess.
      pushShock(-railX, sw.gapX - half, sw.z, sw.life, inten)
      pushShock(sw.gapX + half, railX, sw.z, sw.life, inten)
    }

    darkMesh.count = nDark
    glowMesh.count = nGlow
    bandMesh.count = nShock
    wallMesh.count = nShock

    // Each buffer gets its OWN flag. Setting only instanceMatrix.needsUpdate
    // leaves every tint frozen at its boot value while the rings slide around --
    // rings that move but never pulse, flash or fade, and no error to find.
    darkMesh.instanceMatrix.needsUpdate = true
    glowMesh.instanceMatrix.needsUpdate = true
    glowMesh.instanceColor.needsUpdate = true
    bandMesh.instanceMatrix.needsUpdate = true
    bandMesh.instanceColor.needsUpdate = true
    wallMesh.instanceMatrix.needsUpdate = true
    wallMesh.instanceColor.needsUpdate = true
  }

  /**
   * An expanding blast front on the road.
   * @param {number} r0 radius at t=0, @param {number} r1 radius at death
   * @param {number} tone 0 fire, 1 toxic (bloater), 2 cyan (bubble/energy)
   */
  function addShockRing(x, z, r0, r1, life, tone) {
    const i = srCur
    srCur = (srCur + 1) % SHOCKRING_CAP
    srX[i] = x
    srZ[i] = z
    srR0[i] = r0 > 0 ? r0 : 0.3
    srR1[i] = r1 > r0 ? r1 : r0 * 3
    srLife[i] = life > 0 ? life : 0.5
    srTone[i] = tone | 0
    srT[i] = 0
  }

  /** Leave a red marker frozen where a soldier died. */
  function addDeathRing(x, z) {
    deathX[deathCur] = x
    deathZ[deathCur] = z
    deathT[deathCur] = 0
    deathCur = (deathCur + 1) % DEATH_CAP
  }

  function reset() {
    deathT.fill(-1)
    deathCur = 0
    srT.fill(-1)
    srCur = 0
    nDark = 0
    nGlow = 0
    nShock = 0
    darkMesh.count = 0
    glowMesh.count = 0
    bandMesh.count = 0
    wallMesh.count = 0
  }

  function dispose() {
    for (let i = 0; i < meshes.length; i++) {
      scene.remove(meshes[i])
      meshes[i].dispose()
    }
    darkGeo.dispose(); glowGeo.dispose(); bandGeo.dispose(); wallGeo.dispose()
    darkMat.dispose(); glowMat.dispose(); bandMat.dispose(); wallMat.dispose()
    contactTex.dispose()
    glowTex.dispose()
  }

  return { sync, addDeathRing, addShockRing, reset, dispose }
}
