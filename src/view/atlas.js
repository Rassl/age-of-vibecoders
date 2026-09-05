/**
 * The one glyph atlas. Every number the player reads -- barrel HP, bubble reward
 * badges, floating damage -- is a textured quad sampled out of THIS canvas.
 *
 * It exists to make runtime `fillText` impossible. Re-rasterising a 512x512 RGBA
 * canvas costs ~1MB of texture upload; four barrels ticking their HP at once puts
 * four of those in one frame, and that frame is by definition the busiest one in
 * the run. Bake at boot, never touch the pixels again.
 *
 * CHANNEL LAYOUT -- consumers must know this. Alpha is glyph coverage. RED is the
 * fill mask: ~1 inside the letter, ~0 in the dark outline. Sample as
 *   vec3 c = mix(outlineColor, tintColor, texel.r);  // alpha = texel.a
 * so a digit can be tinted green/amber/red for time-to-kill while its outline
 * stays dark enough to read against both `#C2A878` sand and a `#C0392B` barrel.
 * A single-channel white glyph would have to choose one of those to lose.
 */
import {
  CanvasTexture, ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter,
  SRGBColorSpace,
} from 'three'

/**
 * Digits, the four arithmetic marks, and the letter union of every word the view
 * can print: MINIGUN / SHOTGUN / RIFLE / PISTOL / MISSED, plus A and K so a future
 * 'MAX' or '2K' does not force a re-bake, and W/Y for the wings badge ('FLY').
 * 33 glyphs into 64 cells.
 */
export const GLYPH_CHARS = '0123456789+-x%MINGUSHOTRFLEDPAKWY'

const SIZE = 512
const COLS = 8
const ROWS = 8
const CELL_W = SIZE / COLS
const CELL_H = SIZE / ROWS
const MARGIN = 8          // px of dead space per cell -- the outline needs room
const FONT = '900 46px Impact, Haettenschweiler, "Arial Narrow", "Arial Black", system-ui, sans-serif'
const OUTLINE = '#141008'
const FILL = '#ffffff'

// Half a texel of inset on every cell rect. Without it, bilinear filtering at the
// far end of the corridor samples across the cell seam and a '1' grows a ghost of
// whatever glyph is baked next to it.
const INSET = 0.5 / SIZE

/**
 * Bake the atlas. Call ONCE at boot; the returned object is immutable and its
 * `cellUv` allocates nothing, so it is safe on the frame path.
 */
export function createGlyphAtlas() {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('atlas: no 2d context')

  ctx.clearRect(0, 0, SIZE, SIZE)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  ctx.font = FONT

  // charCode -> cell index. -1 means "not baked" and resolves to the blank cell,
  // so a stray character prints nothing rather than a garbage glyph.
  const lut = new Int16Array(128).fill(-1)
  const blank = GLYPH_CHARS.length
  const maxInk = CELL_W - MARGIN * 2

  for (let i = 0; i < GLYPH_CHARS.length; i++) {
    const ch = GLYPH_CHARS[i]
    lut[ch.charCodeAt(0)] = i
    const cx = (i % COLS) * CELL_W + CELL_W * 0.5
    const cy = ((i / COLS) | 0) * CELL_H + CELL_H * 0.5

    // Condense to fit instead of trusting the stack. Impact is not installed
    // everywhere and the fallback is much wider; an overflowing glyph bleeds into
    // its neighbour's cell and the bleed only shows up at mip level 1, i.e. at
    // exactly the distance where the number matters most.
    const ink = ctx.measureText(ch).width

    ctx.save()
    ctx.translate(cx, cy)
    if (ink > maxInk) ctx.scale(maxInk / ink, 1)
    // Two stroke passes: the wide one carries the silhouette, the narrow one
    // re-darkens the thin joins the round linejoin leaves translucent.
    ctx.strokeStyle = OUTLINE
    ctx.lineWidth = 10
    ctx.strokeText(ch, 0, 0)
    ctx.lineWidth = 5
    ctx.strokeText(ch, 0, 0)
    ctx.fillStyle = FILL
    ctx.fillText(ch, 0, 0)
    ctx.restore()
  }

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4
  texture.needsUpdate = true

  const du = 1 / COLS
  const dv = 1 / ROWS

  /**
   * Write the UV rect (u0, v0, du, dv) of one glyph into `out` (a Vector4) and
   * return it. Takes a CHAR CODE, not a string, so callers can walk a number with
   * `48 + digit` and never allocate.
   */
  function cellUv(charCode, out) {
    const found = charCode >= 0 && charCode < 128 ? lut[charCode] : -1
    const cell = found < 0 ? blank : found
    const col = cell % COLS
    const row = (cell / COLS) | 0
    // Canvas row 0 is the top; three uploads with flipY, so v counts from the
    // bottom of the image.
    return out.set(
      col * du + INSET,
      1 - (row + 1) * dv + INSET,
      du - INSET * 2,
      dv - INSET * 2,
    )
  }

  return { texture, cellUv, COLS, ROWS, cellW: CELL_W, cellH: CELL_H }
}
