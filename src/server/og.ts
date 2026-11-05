// Share images (Farcaster embeds want 3:2 PNGs), the app icon and the splash image, drawn as SVG and
// rendered with resvg.

import { Resvg } from '@resvg/resvg-js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { FACTIONS, MENU_CYAN, NS, QUIL, SKY_BOTTOM, SKY_TOP, faction, emblem } from '../shared/factions'
import { FONT, rain, skyline, wordmark, wordmarkHeight } from '../shared/keyart'
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

/** the Earth at night (rendered once from the game's own maps and shader), as a data URI for resvg */
const EARTH = `data:image/png;base64,${readFileSync(join(import.meta.dir, 'assets/earth.png')).toString('base64')}`
/** the sphere's radius as a share of half the image */
const EARTH_FILL = 0.915

/** hexagon outlines, like the game's territory cells */
function hexPattern(id: string, color: string, size: number) {
  const w = Math.sqrt(3) * size
  const h = size * 3
  const hex = (x: number, y: number) => {
    const pts = []
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k + Math.PI / 6
      pts.push(`${(x + Math.cos(a) * size * 0.92).toFixed(1)},${(y + Math.sin(a) * size * 0.92).toFixed(1)}`)
    }
    return `<polygon points="${pts.join(' ')}" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2" stroke-opacity="0.75"/>`
  }
  return `<pattern id="${id}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" patternUnits="userSpaceOnUse">${hex(0, 0)}${hex(w, 0)}${hex(w / 2, h / 2)}${hex(0, h)}${hex(w, h)}</pattern>`
}

/**
 * The Earth divided: Network School's territory from the left, Quilibrium's from the right, meeting at
 * a glowing, ragged front line placed by their shares.
 */
function earthArt(cx: number, cy: number, r: number, shares: number[], id: string) {
  const total = shares[0] + shares[1]
  const left = total > 0 ? shares[0] / total : 0.5
  // the front line: a wobbly curve from top to bottom
  const pts: string[] = []
  for (let k = 0; k <= 24; k++) {
    const t = k / 24
    const y = cy - r * 1.05 + t * r * 2.1
    const x = cx - r + 2 * r * left + Math.sin(t * 9.3 + 1.2) * r * 0.06 + Math.sin(t * 3.1) * r * 0.09
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  const line = pts.join(' L')
  const top = cy - r * 1.1, bottom = cy + r * 1.1
  const ns = FACTIONS[NS - 1], q = FACTIONS[QUIL - 1]
  const size = r / EARTH_FILL
  return `
  <defs>
    <clipPath id="${id}c"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
    ${hexPattern(`${id}n`, ns.color, r / 11)}
    ${hexPattern(`${id}q`, q.color, r / 11)}
    <radialGradient id="${id}h" cx="50%" cy="50%" r="50%"><stop offset="0.82" stop-color="#8f5bff" stop-opacity="0.55"/><stop offset="1" stop-color="#8f5bff" stop-opacity="0"/></radialGradient>
    <radialGradient id="${id}s" cx="36%" cy="30%" r="80%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.08"/><stop offset="0.6" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.55"/></radialGradient>
    <filter id="${id}g" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>
  </defs>
  <circle cx="${cx}" cy="${cy}" r="${r * 1.12}" fill="url(#${id}h)"/>
  <image href="${EARTH}" x="${cx - size}" y="${cy - size}" width="${size * 2}" height="${size * 2}"/>
  <g clip-path="url(#${id}c)">
    <path d="M${cx - r * 1.1},${top} L${line} L${cx - r * 1.1},${bottom} Z" fill="url(#${id}n)"/>
    <path d="M${cx + r * 1.1},${top} L${line} L${cx + r * 1.1},${bottom} Z" fill="url(#${id}q)"/>
    <path d="M${line}" fill="none" stroke="#ff8a2a" stroke-width="16" stroke-opacity="0.75" filter="url(#${id}g)"/>
    <path d="M${line}" fill="none" stroke="#ffd27a" stroke-width="4"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}s)"/>
  </g>`
}

const W = 1200
const H = 800

/** night sky over a distant skyline, with rain */
const frame = (body: string, h = H) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">
  <rect width="${W}" height="${h}" fill="${BG}"/>
  ${skyline(W, h, h * 0.86, 'og')}
  ${rain(W, h, 120, 7)}
  ${body}</svg>`

/** both sides' rows: emblem, name, value, and a bar */
function bars(x: number, y: number, width: number, values: number[], total: number, label: (i: number, pct: number) => string, gap = 78) {
  return values
    .map((v, i) => {
      const f = FACTIONS[i]
      const pct = total ? (v / total) * 100 : 0
      const yy = y + i * gap
      return `
      <g transform="translate(${x + 18} ${yy - 10}) scale(0.3)">${emblem(f.id, FONT)}</g>
      <text x="${x + 48}" y="${yy}" font-family="Inter" font-weight="700" font-size="30" fill="#ffffff">${esc(f.name)}</text>
      <text x="${x + width}" y="${yy}" font-family="Inter" font-weight="700" font-size="30" fill="${f.color}" text-anchor="end">${esc(label(i, pct))}</text>
      <rect x="${x + 48}" y="${yy + 14}" width="${width - 48}" height="16" rx="8" fill="#ffffff" fill-opacity="0.1"/>
      <rect x="${x + 48}" y="${yy + 14}" width="${Math.max(16, ((width - 48) * pct) / 100).toFixed(0)}" height="16" rx="8" fill="${f.color}"/>`
    })
    .join('')
}

const cyan = (x: number, y: number, size: number, text: string, anchor = 'middle') =>
  `<text x="${x}" y="${y}" font-family="Inter" font-weight="700" font-size="${size}" text-anchor="${anchor}" fill="#04161c" stroke="#04161c" stroke-width="5" stroke-linejoin="round">${text}</text><text x="${x}" y="${y}" font-family="Inter" font-weight="700" font-size="${size}" text-anchor="${anchor}" fill="${MENU_CYAN}">${text}</text>`

const eyebrow = (x: number, y: number, text: string) =>
  `<text x="${x}" y="${y}" font-family="Inter" font-weight="700" font-size="20" letter-spacing="5" fill="${MENU_CYAN}">${text}</text>`

/** the right-hand column starts here; everything important stays between y 110 and 690, so a 1.91:1 crop keeps it */
const COL = 660
const COL_W = 480

export function battleSvg(b: Battle) {
  const w = faction(b.winner)!
  const mvp = b.top[0]
  const claimed = b.counts.reduce((a, c) => a + c, 0) || 1
  const name = w.name.length > 12 ? 50 : 60
  return frame(`
    ${earthArt(330, 400, 270, b.counts, 'e')}
    ${eyebrow(COL, 150, 'BATTLE RESULT')}
    <g transform="translate(${COL + 30} ${222}) scale(0.5)">${emblem(w.id, FONT)}</g>
    <text x="${COL + 72}" y="${240}" font-family="Inter" font-weight="700" font-size="${name}" fill="${w.color}">${esc(w.name)}</text>
    <text x="${COL}" y="${300}" font-family="Inter" font-weight="700" font-size="44" fill="#ffffff">won the Earth</text>
    ${bars(COL, 386, COL_W, b.counts, claimed, (_i, pct) => `${pct.toFixed(1)}%`)}
    <text x="${COL}" y="${578}" font-family="Inter" font-size="24" fill="#c9cde6">${b.players} players${mvp ? ` · MVP ${esc(plain(mvp.name))} (${mvp.captured} tiles)` : ''}</text>
    ${cyan(COL, 650, 34, 'Pick a side for the next round', 'start')}`)
}

export function lobbySvg(id: string, sizes: number[] | null) {
  const players = sizes ? sizes.reduce((a, b) => a + b, 0) : 0
  return frame(`
    ${earthArt(330, 400, 270, sizes && players ? sizes : [1, 1], 'e')}
    ${eyebrow(COL, 150, 'PRIVATE LOBBY')}
    <text x="${COL}" y="${236}" font-family="Inter" font-weight="700" font-size="62" fill="#ffffff">Join my lobby</text>
    <text x="${COL}" y="${292}" font-family="Inter" font-weight="700" font-size="34" letter-spacing="8" fill="#ffd27a">${esc(id.toUpperCase())}</text>
    ${
      sizes && players
        ? bars(COL, 380, COL_W, sizes, players, (i) => `${sizes[i]} ${sizes[i] === 1 ? 'player' : 'players'}`)
        : `<text x="${COL}" y="${400}" font-family="Inter" font-size="28" fill="#d4d8ee">Network School vs Quilibrium.</text>
           <text x="${COL}" y="${442}" font-family="Inter" font-size="28" fill="#d4d8ee">One Earth, no player cap.</text>`
    }
    ${cyan(COL, 650, 36, 'Tap to pick a side', 'start')}`)
}

/** the title and the two sides, over the divided Earth */
function brand(cx: number, top: number, size: number) {
  const y = top + wordmarkHeight(size) + 56
  // emblem + name, centred on cx (Inter Bold runs about 0.6 em per character)
  const side = (id: number, yy: number) => {
    const f = FACTIONS[id - 1]
    const w = 34 + f.name.length * 30 * 0.6
    const x = cx - w / 2
    return `<g transform="translate(${x + 14} ${yy - 10}) scale(0.34)">${emblem(id, FONT)}</g>
    <text x="${x + 40}" y="${yy}" font-family="Inter" font-weight="700" font-size="30" fill="${f.color}">${esc(f.name)}</text>`
  }
  return `${wordmark(cx, top, size)}
    ${side(NS, y)}
    <text x="${cx}" y="${y + 50}" font-family="Inter" font-weight="700" font-size="20" letter-spacing="4" fill="#ffffff" fill-opacity="0.7" text-anchor="middle">VS</text>
    ${side(QUIL, y + 100)}`
}

export function defaultSvg() {
  return frame(`
    ${earthArt(330, 400, 270, [1, 1], 'e')}
    ${brand(900, 110, 60)}
    ${cyan(900, 650, 34, 'Pick a side. Divide the Earth.')}`)
}

/** the 1.91:1 hero and Open Graph image the mini app manifest asks for */
export const HERO_H = 630
export function heroSvg() {
  return frame(
    `
    ${earthArt(310, 315, 240, [1, 1], 'e')}
    ${brand(880, 40, 50)}
    ${cyan(880, 560, 32, 'Pick a side. Divide the Earth.')}`,
    HERO_H,
  )
}

export function iconSvg() {
  const s = 1024
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs><linearGradient id="isky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${SKY_TOP}"/><stop offset="1" stop-color="${SKY_BOTTOM}"/></linearGradient></defs>
  <rect width="${s}" height="${s}" fill="url(#isky)"/>
  ${earthArt(512, 560, 330, [1, 1], 'i')}
  <g transform="translate(250 230) scale(1.6)">${emblem(NS, FONT)}</g>
  <g transform="translate(774 230) scale(1.6)">${emblem(QUIL, FONT)}</g>
  ${rain(s, s, 90, 5)}</svg>`
}
