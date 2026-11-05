// The HTML shell with per-page Open Graph and Farcaster mini app embed tags, and the mini app manifest.

import { FACTIONS, GAME_NAME, SKY_TOP, faction } from '../shared/factions'
import type { Battle } from '../shared/protocol'

export const SPLASH_BG = SKY_TOP

export type Meta = { title: string; description: string; image: string; url: string; button: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function embed(base: string, m: Meta) {
  const action = (type: string) => ({
    type,
    name: GAME_NAME,
    url: m.url,
    splashImageUrl: `${base}/splash.png`,
    splashBackgroundColor: SPLASH_BG,
  })
  return {
    miniapp: { version: '1', imageUrl: m.image, button: { title: m.button, action: action('launch_miniapp') } },
    // older clients read fc:frame
    frame: { version: '1', imageUrl: m.image, button: { title: m.button, action: action('launch_frame') } },
  }
}

export function metaTags(base: string, m: Meta) {
  const e = embed(base, m)
  return [
    `<title>${esc(m.title)}</title>`,
    `<meta name="description" content="${esc(m.description)}">`,
    `<meta property="og:title" content="${esc(m.title)}">`,
    `<meta property="og:description" content="${esc(m.description)}">`,
    `<meta property="og:image" content="${esc(m.image)}">`,
    `<meta property="og:url" content="${esc(m.url)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="fc:miniapp" content="${esc(JSON.stringify(e.miniapp))}">`,
    `<meta name="fc:frame" content="${esc(JSON.stringify(e.frame))}">`,
  ].join('\n    ')
}

export function homeMeta(base: string): Meta {
  return {
    title: `${GAME_NAME}: the Farcaster split, as a game`,
    description: 'Pick a side (Quilibrium, Network School, Hypersnap or Snapchain) and take the network in a live multiplayer street war.',
    image: `${base}/og/default.png`,
    url: base,
    button: 'Join the war',
  }
}

export function lobbyMeta(base: string, id: string): Meta {
  return {
    title: `Join my ${GAME_NAME} lobby (${id})`,
    description: 'A private war over the Farcaster split. Pick a side and take the network.',
    image: `${base}/og/lobby/${id}.png`,
    url: `${base}/lobby/${id}`,
    button: 'Join the lobby',
  }
}

export function battleMeta(base: string, b: Battle): Meta {
  const w = faction(b.winner)!
  const pct = b.tiles ? ((b.counts[b.winner - 1] / b.tiles) * 100).toFixed(1) : '0'
  return {
    title: `${w.name} won a ${GAME_NAME} battle with ${pct}% of the network`,
    description: FACTIONS.map((f, i) => `${f.name} ${((b.counts[i] / b.tiles) * 100).toFixed(1)}%`).join(' · '),
    image: `${base}/og/battle/${b.id}.png`,
    url: `${base}/battle/${b.id}`,
    button: 'Play the next round',
  }
}

export function inject(template: string, tags: string) {
  return template.replace(/<title>[^<]*<\/title>/, '').replace('<!--divide-meta-->', tags)
}

export function manifest(base: string, env: Record<string, string | undefined> = process.env) {
  const app = {
    version: '1',
    name: GAME_NAME,
    iconUrl: `${base}/icon.png`,
    homeUrl: base,
    imageUrl: `${base}/og/default.png`,
    buttonTitle: 'Join the war',
    splashImageUrl: `${base}/splash.png`,
    splashBackgroundColor: SPLASH_BG,
    subtitle: 'The Farcaster split, as a game',
    description: 'Pick a side in the Farcaster split (Quilibrium, Network School, Hypersnap or Snapchain) and take the network in a live multiplayer war.',
    primaryCategory: 'games',
    tags: ['game', 'multiplayer', 'farcaster', 'hypersnap', 'strategy'],
    tagline: 'Pick a side. Take the network.',
    heroImageUrl: `${base}/og/hero.png`,
    ogTitle: GAME_NAME,
    ogDescription: 'The Farcaster split, as a live multiplayer war.',
    ogImageUrl: `${base}/og/hero.png`,
  }
  // The account association proves the domain belongs to a Farcaster account. It is signed once in a
  // Farcaster client's developer tools and set as env vars; without it the app still opens from embeds.
  const { FARCASTER_HEADER: header, FARCASTER_PAYLOAD: payload, FARCASTER_SIGNATURE: signature } = env
  return {
    ...(header && payload && signature ? { accountAssociation: { header, payload, signature } } : {}),
    miniapp: app,
    frame: app,
  }
}
