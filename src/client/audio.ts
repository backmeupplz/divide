// Music and sound effects. The theme is "Mist City" by Section7 (CC BY 4.0, credited in How to play);
// every effect is synthesized here with Web Audio, so there are no sound files to license or load.

const KEY = 'divide:sound'
let on = true
try {
  on = localStorage.getItem(KEY) !== 'off'
} catch {}

let ctx: AudioContext | null = null
let master: GainNode | null = null
const music = new Audio('/audio/theme.mp3')
music.loop = true
music.preload = 'none'
music.volume = 0.32

function ac() {
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!C) return null
    ctx = new C()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

export const sound = {
  get on() {
    return on
  },
  /** browsers only allow sound after a tap or click: call this from one */
  unlock() {
    if (!on) return
    ac()
    if (music.paused) music.play().catch(() => {})
  },
  toggle() {
    on = !on
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off')
    } catch {}
    if (on) sound.unlock()
    else music.pause()
    return on
  },
  /** quieter music while a round plays, so the effects cut through */
  duck(playing: boolean) {
    music.volume = playing ? 0.22 : 0.32
  },
  play(name: Sfx) {
    if (!on) return
    const c = ac()
    if (!c || !master) return
    SFX[name](c, master, c.currentTime + 0.01)
  },
}

type Voice = (c: AudioContext, out: AudioNode, t: number) => void

function tone(c: AudioContext, out: AudioNode, t: number, o: { type?: OscillatorType; f0: number; f1?: number; dur: number; vol: number; attack?: number }) {
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(o.f0, t)
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(o.vol, t + (o.attack ?? 0.008))
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur)
  osc.connect(g).connect(out)
  osc.start(t)
  osc.stop(t + o.dur + 0.02)
}

function noise(c: AudioContext, out: AudioNode, t: number, dur: number, vol: number, from: number, to: number) {
  const len = Math.ceil(c.sampleRate * dur)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  const src = c.createBufferSource()
  src.buffer = buf
  const f = c.createBiquadFilter()
  f.type = 'bandpass'
  f.Q.value = 1.2
  f.frequency.setValueAtTime(from, t)
  f.frequency.exponentialRampToValueAtTime(to, t + dur)
  const g = c.createGain()
  g.gain.setValueAtTime(vol, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(out)
  src.start(t)
}

const SFX = {
  /** a menu tap */
  click: (c, o, t) => tone(c, o, t, { type: 'triangle', f0: 880, f1: 660, dur: 0.06, vol: 0.18 }),
  /** a side picked */
  pick: (c, o, t) => {
    tone(c, o, t, { type: 'triangle', f0: 523, dur: 0.1, vol: 0.2 })
    tone(c, o, t + 0.07, { type: 'triangle', f0: 784, dur: 0.14, vol: 0.2 })
  },
  /** dropped into the war */
  start: (c, o, t) => {
    noise(c, o, t, 0.5, 0.25, 300, 3000)
    tone(c, o, t, { type: 'sawtooth', f0: 110, f1: 440, dur: 0.45, vol: 0.12, attack: 0.05 })
  },
  /** ground taken: a bright rising chord */
  capture: (c, o, t) => {
    ;[659, 880, 1175].forEach((f, i) => tone(c, o, t + i * 0.05, { type: 'square', f0: f, dur: 0.18, vol: 0.07 }))
  },
  /** a big haul */
  bigCapture: (c, o, t) => {
    ;[523, 659, 784, 1047, 1319].forEach((f, i) => tone(c, o, t + i * 0.055, { type: 'square', f0: f, dur: 0.25, vol: 0.075 }))
    noise(c, o, t, 0.4, 0.12, 2000, 8000)
  },
  /** you cut someone */
  cut: (c, o, t) => {
    tone(c, o, t, { type: 'sawtooth', f0: 1600, f1: 200, dur: 0.18, vol: 0.14 })
    noise(c, o, t, 0.12, 0.2, 4000, 1000)
  },
  /** you got cut */
  died: (c, o, t) => {
    tone(c, o, t, { type: 'sawtooth', f0: 330, f1: 55, dur: 0.6, vol: 0.18 })
    noise(c, o, t, 0.5, 0.3, 1200, 120)
  },
  /** round won */
  win: (c, o, t) => {
    ;[523, 659, 784, 1047].forEach((f, i) => tone(c, o, t + i * 0.12, { type: 'triangle', f0: f, dur: 0.5, vol: 0.18 }))
  },
  /** round lost */
  lose: (c, o, t) => {
    ;[392, 330, 262].forEach((f, i) => tone(c, o, t + i * 0.16, { type: 'triangle', f0: f, dur: 0.5, vol: 0.16 }))
  },
} satisfies Record<string, Voice>

export type Sfx = keyof typeof SFX
