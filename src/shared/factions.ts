// Faction 0 is "nobody". The rest are the sides of the split.
export type Faction = {
  id: number
  name: string
  short: string
  /** the faction's neon, used for territory, trails, flags and text */
  color: string
  /** a second color for the emblem's accent */
  accent: string
  /** who they are in the story */
  role: string
  tagline: string
}

export const FACTIONS: Faction[] = [
  { id: 1, name: 'Network School', short: 'NS', color: '#9b5cff', accent: '#d9c2ff', role: 'The occupation', tagline: 'New management. Please report to orientation.' },
  { id: 2, name: 'Quilibrium', short: 'QUIL', color: '#ff2f8e', accent: '#ff8a2a', role: 'The resistance', tagline: 'Fully decentralized. Mostly vibes, all math.' },
]

export const FACTION_COUNT = FACTIONS.length
export const NS = 1
export const QUIL = 2

export function faction(id: number): Faction | undefined {
  return FACTIONS[id - 1]
}

/** unclaimed ground: dark, wet asphalt */
export const NEUTRAL_COLOR = '#1c1d2b'

export const GAME_NAME = 'The Network Divide'
/** the title's orange gradient, the small pink "The" and the cyan menu glow */
export const TITLE_TOP = '#ffd27a'
export const TITLE_BOTTOM = '#ff7a1a'
export const TITLE_PINK = '#ff4fa3'
export const MENU_CYAN = '#5ff4ff'
/** the rainy dusk sky behind everything */
export const SKY_TOP = '#0b0e1c'
export const SKY_BOTTOM = '#2b1a35'

/**
 * Each side's emblem as an SVG fragment centred on (0, 0) with a radius of about 54, for flags,
 * badges and share images. The game and the share images draw the same marks.
 */
export function emblem(id: number, font = 'Inter') {
  const f = faction(id)
  if (!f) return ''
  switch (id) {
    case NS: // Network School: NS in a hex badge
      return `<path d="M0 -54 L47 -27 L47 27 L0 54 L-47 27 L-47 -27 Z" fill="#160a2c" stroke="${f.color}" stroke-width="7" stroke-linejoin="round"/><text x="0" y="14" font-family="${font}" font-weight="700" font-size="40" text-anchor="middle" fill="${f.accent}">NS</text>`
    case QUIL: // Quilibrium: the round Q with an orange tail
      return `<circle r="50" fill="#22061a" stroke="${f.color}" stroke-width="6"/><circle r="26" fill="none" stroke="${f.color}" stroke-width="12"/><path d="M12 12 L32 32" stroke="${f.accent}" stroke-width="12" stroke-linecap="round"/>`
  }
  return ''
}

/** a standalone emblem SVG at the given pixel size */
export function emblemSvg(id: number, size = 40, font = 'Inter') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-60 -60 120 120" aria-hidden="true">${emblem(id, font)}</svg>`
}
