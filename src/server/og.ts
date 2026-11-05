// Share images (Farcaster embeds want 3:2 PNGs), the app icon and the splash image, drawn as SVG and
// rendered with resvg.

import { Resvg } from '@resvg/resvg-js'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { FACTIONS, MENU_CYAN, NEUTRAL_COLOR, NS, QUIL, SKY_BOTTOM, SKY_TOP, faction, emblem } from '../shared/factions'
import { FONT, cityScene, rain, wordmark } from '../shared/keyart'
import type { Battle } from '../shared/protocol'

const FONTS = [join(import.meta.dir, 'fonts/Inter-Bold.ttf'), join(import.meta.dir, 'fonts/Inter-Regular.ttf')]
const BG = '#0b0c16'

/** renders SVG to PNG; `opaque` drops the alpha channel (the mini app icon must not have one) */
export function render(svg: string, width?: number, opaque = false): Uint8Array {
  const r = new Resvg(svg, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
  })
  const img = r.render()
  return opaque ? rgbPng(img.width, img.height, img.pixels) : img.asPng()
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** an 8-bit RGB PNG from premultiplied RGBA pixels, composited over black */
export function rgbPng(width: number, height: number, rgba: Uint8Array) {
  const raw = new Uint8Array((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      raw.set(rgba.subarray(s, s + 3), row + 1 + x * 3)
    }
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width)
  v.setUint32(4, height)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** keeps names to characters the bundled font has */
export const plain = (s: string, max = 24) => {
  const t = s.replace(/[^\w.@ -]/g, '').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** a hex-tile disc split into faction territories, like the planet in the game */
/** x of the i-th faction badge, centred on the card */
const slot = (i: number) => 600 + (i - (FACTIONS.length - 1) / 2) * 160

function planetArt(cx: number, cy: number, r: number, shares: number[], seed = 1) {
  const total = Math.max(1, shares.reduce((a, b) => a + b, 0))
  const fills: { color: string; end: number }[] = []
  let acc = 0
  shares.forEach((s, i) => {
    acc += s / total
    fills.push({ color: FACTIONS[i]?.color ?? NEUTRAL_COLOR, end: acc })
  })
  const size = r / 9
  const w = Math.sqrt(3) * size
  const out: string[] = []
  const sectorAt = (x: number, y: number) => {
    const a = (Math.atan2(y - cy, x - cx) / (2 * Math.PI) + 1 + seed * 0.13) % 1
    return fills.findIndex((f) => a <= f.end + 1e-9)
  }
  for (let row = -12; row <= 12; row++) {
    for (let col = -12; col <= 12; col++) {
      const x = cx + col * w + (row % 2 ? w / 2 : 0)
      const y = cy + row * size * 1.5
      const d = Math.hypot(x - cx, y - cy)
      if (d > r - size * 0.4) continue
      const sector = sectorAt(x, y)
      const color = sector < 0 ? NEUTRAL_COLOR : fills[sector].color
      // tiles next to a border shrink, opening glowing cracks between the territories
      let border = false
      for (let k = 0; k < 6 && !border; k++) {
        const a = (Math.PI / 3) * k
        if (sectorAt(x + Math.cos(a) * w, y + Math.sin(a) * w) !== sector) border = true
      }
      // tiles shrink toward the rim so the disc reads as a sphere
      const s = size * (border ? 0.72 : 0.94) * (0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - (d / r) ** 2)))
      const pts = []
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k + Math.PI / 6
        pts.push(`${(x + Math.cos(a) * s).toFixed(1)},${(y + Math.sin(a) * s).toFixed(1)}`)
      }
      out.push(`<polygon points="${pts.join(' ')}" fill="${color}"/>`)
    }
  }
  return `
    <defs>
      <radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#fff1b0"/><stop offset="55%" stop-color="#ff7a1a"/><stop offset="100%" stop-color="#3a0f1a"/></radialGradient>
      <radialGradient id="shade" cx="38%" cy="32%" r="75%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="60%" stop-color="#000000" stop-opacity="0"/><stop offset="100%" stop-color="#000000" stop-opacity="0.6"/></radialGradient>
      <radialGradient id="halo" cx="50%" cy="50%" r="50%"><stop offset="70%" stop-color="#9b5cff" stop-opacity="0.35"/><stop offset="100%" stop-color="#9b5cff" stop-opacity="0"/></radialGradient>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${r * 1.18}" fill="url(#halo)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#core)"/>
    ${out.join('')}
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#shade)"/>`
}

const W = 1200
const H = 800

/** the rainy street with both sides, dimmed in the middle where the text goes */
const frame = (body: string, dim = 0.55, h = H) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">
  <rect width="${W}" height="${h}" fill="${BG}"/>
  ${cityScene(W, h, (0.82 * h) / H)}
  <defs><radialGradient id="scrim" cx="50%" cy="55%" r="55%"><stop offset="0" stop-color="#07060d" stop-opacity="${dim}"/><stop offset="1" stop-color="#07060d" stop-opacity="0"/></radialGradient></defs>
  <rect width="${W}" height="${h}" fill="url(#scrim)"/>
  ${body}</svg>`

/** a dark glass panel with a cyan rim, like the menu's */
const panel = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="#0a0b16" fill-opacity="0.84" stroke="${MENU_CYAN}" stroke-opacity="0.55" stroke-width="2"/>`

function bars(x: number, y: number, width: number, values: number[], total: number, label: (i: number, pct: number) => string) {
  return values
    .map((v, i) => {
      const f = FACTIONS[i]
      const pct = total ? (v / total) * 100 : 0
      // the rows share the space four rows used to fill
      const yy = y + i * Math.min(110, 264 / values.length)
      return `
      <g transform="translate(${x + 18} ${yy - 10}) scale(0.26)">${emblem(f.id, FONT)}</g>
      <text x="${x + 44}" y="${yy}" font-family="Inter" font-weight="700" font-size="27" fill="#ffffff">${esc(f.name)}</text>
      <text x="${x + width}" y="${yy}" font-family="Inter" font-weight="700" font-size="27" fill="${f.color}" text-anchor="end">${esc(label(i, pct))}</text>
      <rect x="${x + 44}" y="${yy + 12}" width="${width - 44}" height="14" rx="7" fill="#1d1b2e"/>
      <rect x="${x + 44}" y="${yy + 12}" width="${Math.max(14, ((width - 44) * pct) / 100).toFixed(0)}" height="14" rx="7" fill="${f.color}"/>`
    })
    .join('')
}

const cyan = (x: number, y: number, size: number, text: string) =>
  `<text x="${x}" y="${y}" font-family="Inter" font-weight="700" font-size="${size}" text-anchor="middle" fill="#04161c" stroke="#04161c" stroke-width="5" stroke-linejoin="round">${text}</text><text x="${x}" y="${y}" font-family="Inter" font-weight="700" font-size="${size}" text-anchor="middle" fill="${MENU_CYAN}">${text}</text>`

export function battleSvg(b: Battle) {
  const w = faction(b.winner)!
  const total = b.tiles
  const mvp = b.top[0]
  return frame(`
    ${wordmark(600, 22, 54)}
    ${panel(330, 222, 540, 520)}
    <g transform="translate(386 282) scale(0.42)">${emblem(w.id, FONT)}</g>
    <text x="424" y="298" font-family="Inter" font-weight="700" font-size="44" fill="${w.color}">${esc(w.name)} won</text>
    ${bars(362, 400, 476, b.counts, total, (_i, pct) => `${pct.toFixed(1)}%`)}
    <text x="600" y="660" font-family="Inter" font-size="24" fill="#b9bfdc" text-anchor="middle">${b.players} players${mvp ? ` · MVP ${esc(plain(mvp.name))} (${mvp.captured} tiles)` : ''}</text>
    ${cyan(600, 712, 30, 'Pick a side for the next round')}`)
}

export function lobbySvg(id: string, sizes: number[] | null) {
  const players = sizes ? sizes.reduce((a, b) => a + b, 0) : 0
  return frame(`
    ${wordmark(600, 22, 54)}
    ${panel(330, 222, 540, 520)}
    <text x="600" y="300" font-family="Inter" font-weight="700" font-size="54" fill="#ffffff" text-anchor="middle">Join my lobby</text>
    <text x="600" y="346" font-family="Inter" font-size="26" fill="#b9bfdc" text-anchor="middle">Lobby ${esc(id)}${sizes ? ` · ${players} in the war now` : ''}</text>
    ${
      sizes && players
        ? bars(362, 412, 476, sizes, players, (i) => `${sizes[i]} ${sizes[i] === 1 ? 'player' : 'players'}`)
        : `${FACTIONS.map((f, i) => `<g transform="translate(${slot(i)} 470) scale(0.62)">${emblem(f.id, FONT)}</g><text x="${slot(i)}" y="538" font-family="Inter" font-weight="700" font-size="19" fill="${f.color}" text-anchor="middle">${f.name.split(' ').map((w, k) => `<tspan x="${slot(i)}" dy="${k ? 22 : 0}">${esc(w)}</tspan>`).join('')}</text>`).join('')}
    <text x="600" y="606" font-family="Inter" font-size="26" fill="#d4d8ee" text-anchor="middle">Two sides, one network, no player cap.</text>`
    }
    ${cyan(600, 712, 32, 'Tap to pick a side')}`)
}

export function defaultSvg() {
  return frame(
    `
    ${planetArt(600, 470, 150, [4, 4, 2], 3)}
    <defs><linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#07060d" stop-opacity="0"/><stop offset="0.45" stop-color="#07060d" stop-opacity="0.8"/><stop offset="1" stop-color="#07060d" stop-opacity="0.9"/></linearGradient></defs>
    <rect y="620" width="1200" height="180" fill="url(#band)"/>
    ${wordmark(600, 30, 66)}
    ${cyan(600, 700, 34, 'Pick a side. Claim the network.')}
    <text x="600" y="748" font-family="Inter" font-size="24" fill="#d4d8ee" text-anchor="middle">Network School vs Quilibrium</text>`,
    0.25,
  )
}

/** the 1.91:1 hero and Open Graph image the mini app manifest asks for */
export const HERO_H = 630
export function heroSvg() {
  return frame(
    `
    ${planetArt(600, 380, 120, [4, 4, 2], 3)}
    ${wordmark(600, 22, 52)}
    <defs><linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#07060d" stop-opacity="0"/><stop offset="0.45" stop-color="#07060d" stop-opacity="0.8"/><stop offset="1" stop-color="#07060d" stop-opacity="0.9"/></linearGradient></defs>
    <rect y="500" width="1200" height="130" fill="url(#band)"/>
    ${cyan(600, 576, 32, 'Pick a side. Claim the network.')}`,
    0.25,
    HERO_H,
  )
}

export function iconSvg() {
  const s = 1024
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs><linearGradient id="isky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${SKY_TOP}"/><stop offset="1" stop-color="${SKY_BOTTOM}"/></linearGradient></defs>
  <rect width="${s}" height="${s}" fill="url(#isky)"/>
  ${planetArt(512, 540, 330, [1, 1], 0)}
  <g transform="translate(250 230) scale(1.6)">${emblem(QUIL, FONT)}</g>
  <g transform="translate(774 230) scale(1.6)">${emblem(NS, FONT)}</g>
  ${rain(s, s, 90, 5)}</svg>`
}
