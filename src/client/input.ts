// Steering. Every control produces a screen direction (x right, y up); the scene turns it into a direction
// on the planet. Touch: drag anywhere like a joystick. Mouse: point where to go. Keys: WASD or arrows.

export class Input {
  /** the current wanted screen direction, or null while nothing steers */
  dir: { x: number; y: number } | null = null
  /** screen position of the player, for mouse steering */
  anchor = { x: 0, y: 0 }
  private keys = new Set<string>()
  private touchId: number | null = null
  private origin = { x: 0, y: 0 }
  /** finger distance at the last pinch step, 0 when not pinching */
  private pinch = 0
  private stick: HTMLElement
  private knob: HTMLElement
  enabled = false
  onZoom: (factor: number) => void = () => {}

  constructor(private el: HTMLElement) {
    this.stick = document.createElement('div')
    this.stick.className = 'stick'
    this.knob = document.createElement('div')
    this.knob.className = 'knob'
    this.stick.appendChild(this.knob)
    document.body.appendChild(this.stick)

    window.addEventListener('keydown', (e) => {
      if (!this.enabled || (e.target as HTMLElement)?.tagName === 'INPUT') return
      const k = key(e)
      if (!k) return
      this.keys.add(k)
      this.fromKeys()
      e.preventDefault()
    })
    window.addEventListener('keyup', (e) => {
      const k = key(e)
      if (!k) return
      this.keys.delete(k)
      if (this.keys.size) this.fromKeys()
    })
    el.addEventListener('mousemove', (e) => {
      if (!this.enabled || this.keys.size) return
      const dx = e.clientX - this.anchor.x, dy = this.anchor.y - e.clientY
      if (Math.hypot(dx, dy) > 12) this.dir = { x: dx, y: dy }
    })
    el.addEventListener('wheel', (e) => this.onZoom(e.deltaY > 0 ? 1.08 : 1 / 1.08), { passive: true })
    el.addEventListener('touchstart', (e) => {
      if (!this.enabled) return
      const t = e.changedTouches[0]
      if (this.touchId === null && t) {
        this.touchId = t.identifier
        this.origin = { x: t.clientX, y: t.clientY }
        this.stick.style.transform = `translate(${t.clientX}px, ${t.clientY}px)`
        this.knob.style.transform = 'translate(-50%, -50%)'
        this.stick.classList.add('on')
      }
      if (e.touches.length === 2) this.pinch = spread(e.touches)
      e.preventDefault()
    }, { passive: false })
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && this.pinch) {
        // two fingers zoom; spreading them zooms in
        const d = spread(e.touches)
        if (d > 0) this.onZoom(this.pinch / d)
        this.pinch = d
      }
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== this.touchId) continue
        let dx = t.clientX - this.origin.x, dy = t.clientY - this.origin.y
        const len = Math.hypot(dx, dy)
        if (len > 10) this.dir = { x: dx, y: -dy }
        // the base follows a finger that drags past the rim, so turning back is always a short move
        const max = 48
        if (len > max) {
          this.origin.x += (dx / len) * (len - max)
          this.origin.y += (dy / len) * (len - max)
          dx = (dx / len) * max
          dy = (dy / len) * max
          this.stick.style.transform = `translate(${this.origin.x}px, ${this.origin.y}px)`
        }
        this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
      }
      e.preventDefault()
    }, { passive: false })
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) this.pinch = 0
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== this.touchId) continue
        // let go: keep heading the same way
        this.touchId = null
        this.stick.classList.remove('on')
      }
    }
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
  }

  private fromKeys() {
    let x = 0, y = 0
    if (this.keys.has('l')) x -= 1
    if (this.keys.has('r')) x += 1
    if (this.keys.has('u')) y += 1
    if (this.keys.has('d')) y -= 1
    if (x || y) this.dir = { x, y }
  }
}

function key(e: KeyboardEvent) {
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': return 'l'
    case 'ArrowRight': case 'd': case 'D': return 'r'
    case 'ArrowUp': case 'w': case 'W': return 'u'
    case 'ArrowDown': case 's': case 'S': return 'd'
  }
  return null
}

function spread(t: TouchList) {
  return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
}
