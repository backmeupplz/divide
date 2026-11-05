// The key art: a rainy street at dusk where the scrappy resistance (Quilibrium's Q flag over a
// worn-out apartment block and its barricades) faces the occupation (Network School's glass HQ with
// its searchlights, banners, surveillance screen and checkpoint). Plain SVG, so the menu draws it
// in the browser and the share images draw the same thing on the server with resvg.

import { FACTIONS, SKY_BOTTOM, SKY_TOP, TITLE_BOTTOM, TITLE_PINK, TITLE_TOP, emblem } from './factions'

export const FONT = 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
/** both sides are drawn in this box, standing on its bottom edge */
export const SIDE_W = 600
export const SIDE_H = 700

const Q = FACTIONS[3]
const NS = FACTIONS[2]

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
}

const f1 = (n: number) => n.toFixed(1)

function windows(x: number, y: number, cols: number, rows: number, w: number, h: number, gx: number, gy: number, lit: string, dark: string, chance: number, seed: number) {
  const r = rng(seed)
  const out: string[] = []
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const on = r() < chance
      out.push(`<rect x="${x + col * gx}" y="${y + row * gy}" width="${w}" height="${h}" fill="${on ? lit : dark}"${on ? ` opacity="${f1(0.55 + r() * 0.45)}"` : ''}/>`)
    }
  return out.join('')
}

/** concrete barriers with hazard stripes; `stripe` picks the stripe color */
function barrier(x: number, y: number, w: number, stripe: string) {
  const h = 62
  const stripes: string[] = []
  for (let k = 14; k < w - 10; k += 34) stripes.push(`<path d="M${x + k} ${y + h - 8} L${x + k + 16} ${y + 10} L${x + k + 28} ${y + 10} L${x + k + 12} ${y + h - 8} Z" fill="${stripe}" opacity="0.85"/>`)
  return `<path d="M${x} ${y + h} L${x + 8} ${y + 8} L${x + w - 8} ${y + 8} L${x + w} ${y + h} Z" fill="#7d7a88"/><rect x="${x + 8}" y="${y + 8}" width="${w - 16}" height="6" fill="#a19fad"/>${stripes.join('')}<rect x="${x}" y="${y + h - 4}" width="${w}" height="4" fill="#3b3946"/>`
}

/** the resistance's corner of the street, inside a SIDE_W x SIDE_H box */
export function resistanceSide(p = 'r') {
  return `
  <defs>
    <linearGradient id="${p}wall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2b2c3a"/><stop offset="1" stop-color="#3a3a4a"/></linearGradient>
    <radialGradient id="${p}fire" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffb347" stop-opacity="0.75"/><stop offset="1" stop-color="#ff5a1f" stop-opacity="0"/></radialGradient>
    <linearGradient id="${p}flame" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff5a1f"/><stop offset="0.6" stop-color="#ffb347"/><stop offset="1" stop-color="#fff1a8"/></linearGradient>
  </defs>
  <rect x="20" y="70" width="330" height="630" fill="url(#${p}wall)"/>
  <rect x="20" y="70" width="330" height="10" fill="#4a4a5c"/>
  ${[150, 230, 310, 390, 470, 550].map((y) => `<rect x="20" y="${y}" width="330" height="2" fill="#24242f"/>`).join('')}
  ${windows(44, 100, 5, 11, 34, 26, 60, 48, '#ffb35c', '#151621', 0.3, 7)}
  <rect x="330" y="300" width="180" height="400" fill="#1f2030"/>
  ${windows(350, 330, 3, 7, 26, 20, 50, 44, '#ff9d4a', '#121320', 0.25, 11)}
  <path d="M432 700 L468 206" stroke="#2e2a33" stroke-width="7" stroke-linecap="round"/>
  <path d="M466 216 C500 206 530 230 586 214 L578 248 L590 262 L574 280 L586 300 C540 312 500 290 458 304 Z" fill="${Q.color}"/>
  <path d="M461 272 C500 262 540 284 584 274 L574 290 L586 300 C540 312 500 290 458 304 Z" fill="${Q.accent}"/>
  <g transform="translate(518 256) scale(0.34)">${emblem(4, FONT)}</g>
  <circle cx="92" cy="612" r="90" fill="url(#${p}fire)"/>
  <path d="M70 600 C74 572 86 586 90 560 C98 578 104 570 108 548 C116 574 120 586 116 604 Z" fill="url(#${p}flame)"/>
  <rect x="64" y="600" width="58" height="100" rx="5" fill="#5a2e22"/>
  <rect x="64" y="624" width="58" height="5" fill="#3a1d16"/><rect x="64" y="664" width="58" height="5" fill="#3a1d16"/>
  ${barrier(180, 638, 150, '#c2414b')}
  ${barrier(320, 642, 140, Q.color)}
  ${barrier(250, 590, 130, '#c2414b')}
  <ellipse cx="500" cy="684" rx="46" ry="16" fill="#121118"/><ellipse cx="500" cy="684" rx="20" ry="6" fill="#26242e"/>
  <ellipse cx="540" cy="668" rx="44" ry="15" fill="#18171f"/><ellipse cx="540" cy="668" rx="19" ry="6" fill="#2a2832"/>`
}

/** the occupation's side of the street, inside a SIDE_W x SIDE_H box */
export function occupationSide(p = 'o') {
  const screenBars = rng(5)
  const glitch: string[] = []
  for (let k = 0; k < 7; k++) {
    const y = 262 + screenBars() * 150
    glitch.push(`<rect x="${f1(290 + screenBars() * 120)}" y="${f1(y)}" width="${f1(40 + screenBars() * 110)}" height="${f1(3 + screenBars() * 7)}" fill="#e3ccff" opacity="${f1(0.25 + screenBars() * 0.5)}"/>`)
  }
  const banner = (x: number) =>
    `<rect x="${x}" y="300" width="34" height="150" fill="${NS.color}" opacity="0.9"/><path d="M${x} 450 L${x + 17} 438 L${x + 34} 450 Z" fill="#1a1426"/><g transform="translate(${x + 17} 330) scale(0.22)">${emblem(3, FONT)}</g>`
  return `
  <defs>
    <linearGradient id="${p}beam" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#c9a6ff" stop-opacity="0.55"/><stop offset="1" stop-color="#9b5cff" stop-opacity="0"/></linearGradient>
    <linearGradient id="${p}glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2c2e44"/><stop offset="1" stop-color="#1b1c2c"/></linearGradient>
    <radialGradient id="${p}glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${NS.color}" stop-opacity="0.6"/><stop offset="1" stop-color="${NS.color}" stop-opacity="0"/></radialGradient>
  </defs>
  <path d="M262 50 L0 -60 L0 20 Z" fill="url(#${p}beam)"/>
  <path d="M312 48 L120 -90 L200 -90 Z" fill="url(#${p}beam)"/>
  <rect x="254" y="44" width="16" height="16" rx="3" fill="#4a4c66"/><circle cx="262" cy="50" r="5" fill="#efe4ff"/>
  <rect x="304" y="42" width="16" height="18" rx="3" fill="#4a4c66"/><circle cx="312" cy="48" r="5" fill="#efe4ff"/>
  <rect x="230" y="60" width="370" height="640" fill="url(#${p}glass)"/>
  <rect x="230" y="60" width="370" height="8" fill="#3d3f58"/>
  ${windows(250, 470, 7, 4, 40, 22, 50, 40, '#b48cff', '#141526', 0.55, 3)}
  ${windows(250, 90, 2, 8, 40, 22, 290, 40, '#b48cff', '#141526', 0.5, 9)}
  <circle cx="415" cy="140" r="110" fill="url(#${p}glow)"/>
  <g transform="translate(415 142) scale(0.95)">${emblem(3, FONT)}</g>
  <rect x="282" y="252" width="266" height="190" fill="#090614"/>
  <rect x="290" y="260" width="250" height="174" fill="#3a1f78"/>
  <ellipse cx="415" cy="347" rx="70" ry="38" fill="none" stroke="#d9c2ff" stroke-width="6" opacity="0.8"/>
  <circle cx="415" cy="347" r="20" fill="#d9c2ff" opacity="0.85"/><circle cx="415" cy="347" r="8" fill="#1a0d38"/>
  ${[...Array(29)].map((_, k) => `<rect x="290" y="${262 + k * 6}" width="250" height="2" fill="#000" opacity="0.28"/>`).join('')}
  ${glitch.join('')}
  ${banner(240)}${banner(556)}
  <rect x="40" y="560" width="130" height="140" fill="#262838"/>
  <rect x="30" y="548" width="150" height="16" fill="#3a3c52"/>
  <rect x="56" y="584" width="98" height="48" fill="#c9b3ff" opacity="0.75"/>
  <rect x="40" y="640" width="130" height="4" fill="${NS.color}"/>
  <rect x="170" y="606" width="200" height="12" fill="#e8e6f0"/>
  ${[...Array(5)].map((_, k) => `<rect x="${178 + k * 40}" y="606" width="18" height="12" fill="${NS.color}"/>`).join('')}
  <rect x="166" y="600" width="10" height="100" fill="#3a3c52"/>
  ${barrier(380, 640, 150, '#e8e6f0')}
  ${barrier(250, 646, 120, NS.color)}`
}

/** a far skyline, the low orange glow of the horizon and the rain, filling w x h */
export function skyline(w: number, h: number, horizon: number, p = 's') {
  const r = rng(21)
  const towers: string[] = []
  for (let x = -20; x < w; ) {
    const bw = 30 + r() * 70
    const bh = 40 + r() * 160
    towers.push(`<rect x="${f1(x)}" y="${f1(horizon - bh)}" width="${f1(bw)}" height="${f1(bh + 4)}" fill="#1b1a2b"/>`)
    if (r() < 0.5) towers.push(`<rect x="${f1(x + bw / 2 - 1)}" y="${f1(horizon - bh - 30)}" width="2" height="30" fill="#1b1a2b"/><circle cx="${f1(x + bw / 2)}" cy="${f1(horizon - bh - 30)}" r="2.5" fill="#ff4f6a"/>`)
    x += bw + r() * 10
  }
  return `
  <defs>
    <linearGradient id="${p}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${SKY_TOP}"/><stop offset="0.75" stop-color="${SKY_BOTTOM}"/><stop offset="1" stop-color="#5a2a3a"/></linearGradient>
    <radialGradient id="${p}dusk" cx="50%" cy="100%" r="60%"><stop offset="0" stop-color="#ff7a3a" stop-opacity="0.55"/><stop offset="1" stop-color="#ff7a3a" stop-opacity="0"/></radialGradient>
    <linearGradient id="${p}street" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d1a2a"/><stop offset="1" stop-color="#0b0a12"/></linearGradient>
  </defs>
  <rect width="${w}" height="${horizon}" fill="url(#${p}sky)"/>
  <ellipse cx="${w / 2}" cy="${horizon}" rx="${w * 0.45}" ry="${horizon * 0.35}" fill="url(#${p}dusk)"/>
  ${towers.join('')}
  <rect y="${horizon}" width="${w}" height="${h - horizon}" fill="url(#${p}street)"/>`
}

/** slanted rain streaks over a w x h box */
export function rain(w: number, h: number, n = 160, seed = 3) {
  const r = rng(seed)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const x = r() * (w + 100), y = r() * h, l = 14 + r() * 26
    out.push(`<path d="M${f1(x)} ${f1(y)} l${f1(-l * 0.22)} ${f1(l)}" stroke="#b9c6ff" stroke-width="${f1(0.8 + r())}" opacity="${f1(0.12 + r() * 0.25)}"/>`)
  }
  return out.join('')
}

/** neon spilled on the wet street */
export function reflections(w: number, y: number, h: number, p = 'f') {
  return `
  <defs>
    <linearGradient id="${p}refQ" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${Q.color}" stop-opacity="0.4"/><stop offset="1" stop-color="${Q.color}" stop-opacity="0"/></linearGradient>
    <linearGradient id="${p}refN" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${NS.color}" stop-opacity="0.45"/><stop offset="1" stop-color="${NS.color}" stop-opacity="0"/></linearGradient>
    <linearGradient id="${p}refF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a3a" stop-opacity="0.45"/><stop offset="1" stop-color="#ff9a3a" stop-opacity="0"/></linearGradient>
  </defs>
  <rect x="${f1(w * 0.06)}" y="${y}" width="${f1(w * 0.05)}" height="${h}" fill="url(#${p}refF)"/>
  <rect x="${f1(w * 0.3)}" y="${y}" width="${f1(w * 0.03)}" height="${h * 0.8}" fill="url(#${p}refQ)"/>
  <rect x="${f1(w * 0.66)}" y="${y}" width="${f1(w * 0.05)}" height="${h}" fill="url(#${p}refN)"/>
  <rect x="${f1(w * 0.86)}" y="${y}" width="${f1(w * 0.03)}" height="${h * 0.8}" fill="url(#${p}refN)"/>`
}

/**
 * The title treatment: a small pink "The" between dashes over a big two-line "Network Divide" in an
 * orange gradient with a dark outline. Centred on x; `size` is the big lines' font size.
 */
export function wordmark(x: number, y: number, size: number, id = 'title') {
  const small = size * 0.42
  const dash = size * 0.9
  return `
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TITLE_TOP}"/><stop offset="1" stop-color="${TITLE_BOTTOM}"/></linearGradient></defs>
  <rect x="${f1(x - small * 1.2 - dash)}" y="${f1(y + small * 0.62 - 2)}" width="${f1(dash)}" height="4" rx="2" fill="${TITLE_PINK}"/>
  <rect x="${f1(x + small * 1.2)}" y="${f1(y + small * 0.62 - 2)}" width="${f1(dash)}" height="4" rx="2" fill="${TITLE_PINK}"/>
  <text x="${x}" y="${f1(y + small)}" font-family="${FONT}" font-weight="700" font-size="${f1(small)}" text-anchor="middle" fill="${TITLE_PINK}">The</text>
  ${[
    ['Network', y + small + size * 1.02],
    ['Divide', y + small + size * 2],
  ]
    .map(
      ([t, ty]) =>
        `<text x="${x}" y="${f1(ty as number)}" font-family="${FONT}" font-weight="700" font-size="${size}" text-anchor="middle" fill="#2a1206" stroke="#2a1206" stroke-width="${f1(size * 0.1)}" stroke-linejoin="round">${t}</text>` +
        `<text x="${x}" y="${f1(ty as number)}" font-family="${FONT}" font-weight="700" font-size="${size}" text-anchor="middle" fill="url(#${id})">${t}</text>`,
    )
    .join('')}`
}

/** height of the wordmark drawn at `size` */
export const wordmarkHeight = (size: number) => size * 0.42 + size * 2.25

/** the whole street at w x h with both sides, for share images */
export function cityScene(w: number, h: number, sideScale: number) {
  const horizon = h * 0.62
  const sw = SIDE_W * sideScale, sh = SIDE_H * sideScale
  return `
  ${skyline(w, h, horizon)}
  ${reflections(w, h - h * 0.12, h * 0.12)}
  <g transform="translate(${f1(-sw * 0.08)} ${f1(h - sh)}) scale(${sideScale})">${resistanceSide('L')}</g>
  <g transform="translate(${f1(w - sw * 0.98)} ${f1(h - sh)}) scale(${sideScale})">${occupationSide('R')}</g>
  ${rain(w, h)}`
}
