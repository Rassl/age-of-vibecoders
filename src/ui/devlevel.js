/**
 * DEV-ONLY round switcher: jump to any round (and therefore mode -- odd
 * ADVANCE, even HOLDOUT) without winning your way there.
 *
 * Never ships: main.js pulls this in with a dynamic import inside an
 * `import.meta.env.DEV` guard, which is statically false in production, so the
 * whole module falls out of the build. Styling is inline for the same reason --
 * no stylesheet of a dead feature should survive into dist.
 */
const BTN =
  'background:#33281a;border:1px solid #4a3b24;border-radius:4px;color:#ffd98a;' +
  'font:inherit;padding:2px 9px 3px;cursor:pointer;'

export function createDevLevel(api) {
  const box = document.createElement('div')
  box.style.cssText =
    'position:absolute;left:10px;bottom:10px;z-index:30;display:flex;gap:6px;' +
    'align-items:center;pointer-events:auto;font:600 12px/1.4 ui-monospace,monospace;' +
    'color:#EFE3C4;background:rgba(11,13,16,.65);padding:6px 8px;border-radius:6px;' +
    '-webkit-tap-highlight-color:transparent;'

  const label = document.createElement('span')
  label.style.cssText = 'min-width:110px;text-align:center;'

  const mk = (txt, on) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = txt
    b.style.cssText = BTN
    // A tap here must never fall through to the steering drag or the
    // tap-to-deploy scrim underneath.
    for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'mousedown']) {
      b.addEventListener(ev, (e) => e.stopPropagation())
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      on()
      refresh()
      b.blur()
    })
    return b
  }

  function refresh() {
    label.textContent = api.label()
  }

  box.append(
    mk('◀', () => api.set(api.round() - 1)),
    label,
    mk('▶', () => api.set(api.round() + 1)),
  )
  refresh()

  const host = document.getElementById('stage') || document.body
  host.appendChild(box)
  return { refresh }
}
