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
  { id: 1, name: 'Hypersnap', short: 'HYPR', color: '#ff9b2f', accent: '#ffd36b', role: 'The fork', tagline: 'The community fork. Forks are a feature.' },
  { id: 2, name: 'Snapchain', short: 'SNAP', color: '#2fe0d0', accent: '#b8fff6', role: 'The old guard', tagline: 'The original chain. Still producing blocks.' },
  { id: 3, name: 'Network School', short: 'NS', color: '#9b5cff', accent: '#d9c2ff', role: 'The occupation', tagline: 'New management. Please report to orientation.' },
  { id: 4, name: 'Quilibrium', short: 'QUIL', color: '#ff2f8e', accent: '#ff8a2a', role: 'The resistance', tagline: 'Fully decentralized. Mostly vibes, all math.' },
]

export const FACTION_COUNT = FACTIONS.length

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
    case 1: // Hypersnap: a forked branch in a diamond
      return `<path d="M0 -54 L54 0 L0 54 L-54 0 Z" fill="#1a0f05" stroke="${f.color}" stroke-width="7" stroke-linejoin="round"/><path d="M0 28 L0 4 M0 4 L-17 -22 M0 4 L17 -22" stroke="${f.accent}" stroke-width="8" stroke-linecap="round" fill="none"/><circle cx="-17" cy="-22" r="7" fill="${f.color}"/><circle cx="17" cy="-22" r="7" fill="${f.color}"/><circle cx="0" cy="28" r="7" fill="${f.color}"/>`
    case 2: // Snapchain: two chain links
      return `<rect x="-50" y="-50" width="100" height="100" rx="22" fill="#04181a" stroke="${f.color}" stroke-width="7"/><rect x="-36" y="-14" width="42" height="28" rx="14" fill="none" stroke="${f.accent}" stroke-width="8"/><rect x="-6" y="-14" width="42" height="28" rx="14" fill="none" stroke="${f.color}" stroke-width="8"/>`
    case 3: // Network School: NS in a hex badge
      return `<path d="M0 -54 L47 -27 L47 27 L0 54 L-47 27 L-47 -27 Z" fill="#160a2c" stroke="${f.color}" stroke-width="7" stroke-linejoin="round"/><text x="0" y="14" font-family="${font}" font-weight="700" font-size="40" text-anchor="middle" fill="${f.accent}">NS</text>`
    case 4: // Quilibrium: the round Q with an orange tail
      return `<circle r="50" fill="#22061a" stroke="${f.color}" stroke-width="6"/><circle r="26" fill="none" stroke="${f.color}" stroke-width="12"/><path d="M12 12 L32 32" stroke="${f.accent}" stroke-width="12" stroke-linecap="round"/>`
  }
  return ''
}

/** a standalone emblem SVG at the given pixel size */
export function emblemSvg(id: number, size = 40, font = 'Inter') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-60 -60 120 120" aria-hidden="true">${emblem(id, font)}</svg>`
}
