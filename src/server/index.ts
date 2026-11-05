import { createClient } from '@farcaster/quick-auth'
import type { ServerWebSocket } from 'bun'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { BATTLE_ID, ROOM_ID, TICK_HZ, type ClientMsg, type ServerMsg } from '../shared/protocol'
import { openStore, type Store } from './db'
import { battleSvg, defaultSvg, heroSvg, iconSvg, lobbySvg, plain } from './og'
import type { RenderDone, RenderJob } from './og-worker'
import { battleMeta, homeMeta, inject, lobbyMeta, manifest, metaTags } from './pages'
import { Room, randomId, type Player } from './room'

export const WORLD = 'world'
const MAX_ROOMS = 300
const ROOM_IDLE_MS = 10 * 60 * 1000
const MAX_MSGS_PER_S = 60
/** lobby ids are cheap (rooms are not): a created lobby nobody joins lasts this long */
const LOBBY_UNJOINED_MS = 30 * 60 * 1000
/** and a lobby whose match went idle stays joinable this long, so old invites keep working a while */
const LOBBY_IDLE_MS = 6 * 60 * 60 * 1000
const MAX_LOBBIES = 2000
const LOBBIES_PER_IP_PER_MIN = 6
/** share images waiting for the render worker; past this, the default image is served instead */
const MAX_RENDER_QUEUE = 8
/** WebSocket close code for a room that does not exist (any more); clients stop reconnecting */
export const CLOSE_UNKNOWN_ROOM = 4404

type Conn = {
  room: string
  player: Player | null
  joining: boolean
  closed: boolean
  windowStart: number
  msgs: number
}

export type Options = {
  port?: number
  publicUrl?: string
  dist?: string
  dataDir?: string
  /** verifies a Quick Auth token, returning the FID; tests replace it */
  verify?: (token: string) => Promise<number | null>
  /** hosts the game moved away from; they redirect to publicUrl */
  redirectHosts?: string
  /** tests pass a store that fails */
  store?: Store
  /** the Farcaster username and pfp URL for a verified FID; tests replace it */
  lookupUser?: (fid: number) => Promise<FcUser>
  /** fetches a pfp for the /pfp proxy; tests replace it */
  fetchPfp?: (url: string) => Promise<Pfp | null>
}

type FcUser = { username: string | null; pfp: string | null }
type Pfp = { bytes: Uint8Array; type: string }

const USERNAME = /^[a-z0-9][a-z0-9-]{0,15}(\.eth)?$/i

/** looks the username and pfp up by FID, so a verified player can't claim someone else's name or face */
function userLookup(api = process.env.FARCASTER_USER_API ?? 'https://api.farcaster.xyz/v2/user?fid=') {
  const cache = new Map<number, FcUser & { at: number }>()
  return async (fid: number): Promise<FcUser> => {
    const hit = cache.get(fid)
    if (hit && Date.now() - hit.at < (hit.username ? 3600_000 : 60_000)) return hit
    const out: FcUser = { username: null, pfp: null }
    try {
      const r = await fetch(`${api}${fid}`, { signal: AbortSignal.timeout(2500) })
      if (r.ok) {
        const u = ((await r.json()) as { result?: { user?: { fid?: number; username?: unknown; pfp?: { url?: unknown } } } }).result?.user
        if (u?.fid === fid && typeof u.username === 'string' && USERNAME.test(u.username)) out.username = u.username
        if (u?.fid === fid && typeof u.pfp?.url === 'string' && /^https:\/\//.test(u.pfp.url) && u.pfp.url.length < 2048) out.pfp = u.pfp.url
      }
    } catch {}
    if (cache.size > 5000) cache.delete(cache.keys().next().value!)
    cache.set(fid, { ...out, at: Date.now() })
    return out
  }
}

/** a private, loopback or link-local address: the pfp proxy never fetches those */
export function privateAddress(ip: string) {
  if (/^(::1|::|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/i.test(ip)) return true
  const v4 = ip.replace(/^::ffff:/i, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/**
 * Fetches a pfp from the URL a Farcaster user set (anyone can set any URL): https only, public
 * addresses only, no redirects, images only, at most 3 MB.
 */
async function fetchPfp(url: string): Promise<Pfp | null> {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return null
    const { lookup } = await import('node:dns/promises')
    const addrs = await lookup(u.hostname, { all: true })
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return null
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    // raster images only: an SVG can carry script
    const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!r.ok || !/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) return null
    if (Number(r.headers.get('content-length') ?? 0) > 3_000_000) return null
    const bytes = new Uint8Array(await r.arrayBuffer())
    return bytes.length <= 3_000_000 ? { bytes, type } : null
  } catch {
    return null
  }
}

export function start(opts: Options = {}) {
  const base = (opts.publicUrl ?? process.env.PUBLIC_URL ?? 'https://divide.quilcast.com').replace(/\/$/, '')
  const dist = opts.dist ?? join(import.meta.dir, '../../dist')
  const store: Store = opts.store ?? openStore(opts.dataDir)
  /** the store is a nice-to-have for a running match: a failed write is logged, never fatal */
  const soft = (what: string, f: () => void) => {
    try {
      f()
    } catch (e) {
      console.error(`divide: ${what} failed`, e)
    }
  }
  const quickAuth = createClient()
  const domain = new URL(base).hostname
  const verify =
    opts.verify ??
    (async (token: string) => {
      try {
        const payload = await quickAuth.verifyJwt({ token, domain })
        const fid = Number(payload.sub)
        return Number.isInteger(fid) && fid > 0 ? fid : null
      } catch {
        return null
      }
    })

  const lookupUser = opts.lookupUser ?? userLookup()
  const getPfp = opts.fetchPfp ?? fetchPfp
  /** pfp URLs of verified players who joined, by FID: the only ones /pfp serves */
  const pfpUrls = new Map<number, string>()
  const pfps = new Map<number, Promise<Pfp | null>>()
  const oldHosts = new Set((opts.redirectHosts ?? process.env.REDIRECT_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean))

  const rooms = new Map<string, Room>()
  /** issued lobby ids, with when they expire while no match is running in them */
  const lobbies = new Map<string, number>(store.lobbies(Date.now()))
  const setLobby = (id: string, expires: number) => {
    lobbies.set(id, expires)
    soft('saving a lobby', () => store.saveLobby(id, expires))
  }
  const joinable = (id: string) => id === WORLD || rooms.has(id) || lobbies.has(id)
  const created = new Map<string, { n: number; start: number }>()
  const getRoom = (id: string) => {
    let r = rooms.get(id)
    if (!r && rooms.size < MAX_ROOMS) {
      r = new Room(id, { onBattle: (b) => soft('saving a battle', () => store.saveBattle(b)) })
      rooms.set(id, r)
    }
    return r
  }
  getRoom(WORLD)

  // a fixed-step clock: timers fire late and unevenly, but clients map tick numbers onto time, so
  // the ticks must come out at exactly TICK_HZ on average (late ones catch up, a long stall resets)
  const period = 1000 / TICK_HZ
  let due = performance.now()
  let loop: ReturnType<typeof setTimeout>
  const pump = () => {
    let now = performance.now()
    if (now - due > period * 8) due = now
    while (now >= due) {
      tickAll()
      due += period
      now = performance.now()
    }
    loop = setTimeout(pump, Math.max(1, due - now))
  }
  const tickAll = () => {
    const now = Date.now()
    for (const [id, r] of rooms) {
      // one broken room must not take every other match on the server down with it
      if (r.humans > 0) soft(`room ${id} tick`, () => r.step())
      else if (id !== WORLD && now - r.lastHuman > ROOM_IDLE_MS) {
        rooms.delete(id)
        if (lobbies.has(id)) setLobby(id, now + LOBBY_IDLE_MS)
      }
    }
  }
  loop = setTimeout(pump, period)
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, expires] of lobbies) {
      // a lobby with a match on keeps its stored expiry ahead, so a restart mid-match doesn't lose it
      if (rooms.has(id)) setLobby(id, now + LOBBY_IDLE_MS)
      else if (expires < now) {
        lobbies.delete(id)
        soft('dropping a lobby', () => store.dropLobby(id))
      }
    }
    for (const [ip, c] of created) if (now - c.start > 60_000) created.delete(ip)
  }, 15_000)

  let template = ''
  let templateTime = -1
  const html = () => {
    // re-read after a rebuild (dev); in production the file never changes
    const f = join(dist, 'index.html')
    const t = existsSync(f) ? statSync(f).mtimeMs : 0
    if (t !== templateTime) {
      templateTime = t
      template = t ? readFileSync(f, 'utf8') : '<!doctype html><html><head><!--divide-meta--></head><body>Build the client with `bun run build`.</body></html>'
    }
    return template
  }
  const page = (tags: string) => new Response(inject(html(), tags), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })

  // share images render in a worker, so a burst of image requests never stalls the matches
  const worker = new Worker(new URL('./og-worker.ts', import.meta.url).href)
  let jobId = 0
  const jobs = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>()
  worker.onmessage = (e: MessageEvent<RenderDone>) => {
    const j = jobs.get(e.data.id)
    if (!j) return
    jobs.delete(e.data.id)
    if (e.data.bytes) j.resolve(e.data.bytes)
    else j.reject(new Error(e.data.error ?? 'render failed'))
  }
  const renderOff = (svg: string, width?: number, opaque?: boolean) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const id = ++jobId
      jobs.set(id, { resolve, reject })
      worker.postMessage({ id, svg, width, opaque } satisfies RenderJob)
    })

  const images = new Map<string, Uint8Array>()
  const inflight = new Map<string, Promise<Uint8Array>>()
  const pngResponse = (bytes: Uint8Array, maxAge: number) =>
    new Response(bytes as unknown as BodyInit, { headers: { 'content-type': 'image/png', 'cache-control': `public, max-age=${maxAge}` } })
  const png = async (key: string, maxAge: number, draw: () => string, o: { width?: number; opaque?: boolean; fallback?: boolean } = {}): Promise<Response> => {
    const hit = images.get(key)
    if (hit) return pngResponse(hit, maxAge)
    let p = inflight.get(key)
    if (!p) {
      // a flood of different images: serve the default one rather than queueing renders forever
      if (o.fallback !== false && jobs.size >= MAX_RENDER_QUEUE && key !== 'default') return png('default', 60, defaultSvg)
      p = renderOff(draw(), o.width, o.opaque).finally(() => inflight.delete(key))
      inflight.set(key, p)
    }
    const bytes = await p
    images.set(key, bytes)
    if (images.size > 300) images.delete(images.keys().next().value!)
    return pngResponse(bytes, maxAge)
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

  const server = Bun.serve<Conn>({
    port: opts.port ?? Number(process.env.PORT ?? 3000),
    async fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname
      // the game moved: old hosts send people to the new one, but keep serving old casts' share
      // images and anyone still connected
      const host = req.headers.get('host')?.split(':')[0] ?? ''
      if (oldHosts.has(host) && !path.startsWith('/og/') && path !== '/ws' && path !== '/health')
        return Response.redirect(`${base}${path}${url.search}`, 301)
      if (path === '/ws') {
        const room = url.searchParams.get('room') ?? WORLD
        if (!ROOM_ID.test(room)) return new Response('bad room', { status: 400 })
        // unknown rooms are refused after the upgrade, with a close code that stops the client retrying
        const ok = srv.upgrade(req, { data: { room, player: null, joining: false, closed: false, windowStart: Date.now(), msgs: 0 } })
        return ok ? undefined : new Response('upgrade failed', { status: 400 })
      }
      if (path === '/health') return new Response('ok')
      if (path === '/.well-known/farcaster.json') return json(manifest(base))
      if (path === '/api/lobby' && req.method === 'POST') {
        // the proxy appends the address it saw, so the last forwarded entry is the real client
        const ip = req.headers.get('x-forwarded-for')?.split(',').pop()?.trim() || srv.requestIP(req)?.address || '?'
        const now = Date.now()
        const c = created.get(ip)
        if (c && now - c.start < 60_000) {
          if (c.n >= LOBBIES_PER_IP_PER_MIN) return json({ error: 'slow down' }, 429)
          c.n++
        } else created.set(ip, { n: 1, start: now })
        if (lobbies.size >= MAX_LOBBIES) return json({ error: 'too many lobbies' }, 503)
        let id = randomId(6)
        while (joinable(id)) id = randomId(6)
        setLobby(id, now + LOBBY_UNJOINED_MS)
        return json({ id })
      }
      let m: RegExpMatchArray | null
      if ((m = path.match(/^\/api\/room\/([a-z0-9]+)$/))) {
        const r = rooms.get(m[1])
        if (!r) return json({ id: m[1], live: false })
        return json({ id: r.id, live: true, humans: r.humans, sizes: r.factionSizes(), phase: r.phase, endsAt: r.endsAt, now: Date.now() })
      }
      if ((m = path.match(/^\/api\/battle\/([a-z0-9]+)$/))) {
        const b = BATTLE_ID.test(m[1]) ? store.battle(m[1]) : null
        return b ? json(b) : json({ error: 'not found' }, 404)
      }
      if (path === '/api/stats') {
        let players = 0, humans = 0, tickMs = 0
        for (const r of rooms.values()) {
          players += r.players.size
          humans += r.humans
          tickMs = Math.max(tickMs, r.tickMs)
        }
        return json({ rooms: rooms.size, players, humans, maxTickMs: Number(tickMs.toFixed(3)) })
      }
      if ((m = path.match(/^\/pfp\/(\d{1,10})$/))) {
        const fid = Number(m[1])
        const url = pfpUrls.get(fid)
        if (!url) return new Response('not found', { status: 404 })
        let p = pfps.get(fid)
        if (!p) {
          p = getPfp(url)
          pfps.set(fid, p)
          if (pfps.size > 500) pfps.delete(pfps.keys().next().value!)
        }
        const img = await p
        if (!img) {
          pfps.delete(fid)
          return new Response('not found', { status: 404 })
        }
        return new Response(img.bytes as unknown as BodyInit, {
          headers: { 'content-type': img.type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" },
        })
      }
      if (path === '/og/default.png') return png('default', 3600, defaultSvg)
      if (path === '/og/hero.png') return png('hero', 3600, heroSvg, { fallback: false })
      if (path === '/icon.png') return png('icon', 86400, iconSvg, { opaque: true, fallback: false })
      if (path === '/splash.png') return png('splash', 86400, iconSvg, { width: 200, fallback: false })
      if ((m = path.match(/^\/og\/battle\/([a-z0-9]+)\.png$/))) {
        const b = BATTLE_ID.test(m[1]) ? store.battle(m[1]) : null
        return b ? png(`battle:${b.id}`, 86400, () => battleSvg(b)) : png('default', 3600, defaultSvg)
      }
      if ((m = path.match(/^\/og\/lobby\/([a-z0-9]+)\.png$/))) {
        const id = m[1]
        // only lobbies that exist get their own image, so made-up ids can't queue up renders
        if (!ROOM_ID.test(id) || id === WORLD || !joinable(id)) return png('default', 3600, defaultSvg)
        const r = rooms.get(id)
        const sizes = r && r.humans ? r.factionSizes() : null
        // keyed by the line-up, so a lobby re-renders only when its players change
        return png(`lobby:${id}:${sizes?.join(',') ?? ''}`, 60, () => lobbySvg(id, sizes))
      }
      if (path === '/' || path === '/index.html') return page(metaTags(base, homeMeta(base)))
      if ((m = path.match(/^\/lobby\/([a-z0-9]+)\/?$/)) && ROOM_ID.test(m[1])) return page(metaTags(base, lobbyMeta(base, m[1])))
      if ((m = path.match(/^\/battle\/([a-z0-9]+)\/?$/))) {
        const b = BATTLE_ID.test(m[1]) ? store.battle(m[1]) : null
        return page(metaTags(base, b ? battleMeta(base, b) : homeMeta(base)))
      }
      // built client files
      const file = normalize(join(dist, path))
      if (file.startsWith(dist + '/') && existsSync(file) && statSync(file).isFile()) {
        const f = Bun.file(file)
        if (f.size > 0) {
          const immutable = path.startsWith('/assets/')
          return new Response(f, { headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300' } })
        }
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      maxPayloadLength: 2048,
      idleTimeout: 60,
      sendPings: true,
      async message(ws: ServerWebSocket<Conn>, raw) {
        const c = ws.data
        const now = Date.now()
        if (now - c.windowStart > 1000) {
          c.windowStart = now
          c.msgs = 0
        }
        if (++c.msgs > MAX_MSGS_PER_S) return ws.close(1008, 'too many messages')
        if (typeof raw !== 'string') return
        let msg: ClientMsg
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }
        if (!msg || typeof msg !== 'object') return
        if (msg.t === 'dir' && c.player) {
          const { x, y, z } = msg
          if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') rooms.get(c.room)?.steer(c.player, x, y, z)
          return
        }
        if (msg.t === 'join' && !c.player && !c.joining) {
          c.joining = true
          let name = ''
          let verified = false
          let pfpFid = 0
          if (typeof msg.token === 'string' && msg.token.length < 4096) {
            const fid = await verify(msg.token)
            if (fid) {
              verified = true
              // the name comes from the FID, never from what the client says it is
              const user = await lookupUser(fid)
              const u = plain(user.username ?? '', 20)
              name = u ? `@${u}` : `fid:${fid}`
              if (user.pfp) {
                if (pfpUrls.get(fid) !== user.pfp) pfps.delete(fid)
                pfpUrls.set(fid, user.pfp)
                if (pfpUrls.size > 5000) pfpUrls.delete(pfpUrls.keys().next().value!)
                pfpFid = fid
              }
            }
          }
          if (!name) {
            const nick = typeof msg.name === 'string' ? plain(msg.name.replace(/@/g, ''), 16) : ''
            name = nick || `anon-${Math.floor(1000 + Math.random() * 9000)}`
          }
          if (c.closed) return
          if (!joinable(c.room)) {
            ws.send(JSON.stringify({ t: 'error', message: 'That lobby has ended. Start a new one or join the big war.' } satisfies ServerMsg))
            return ws.close(CLOSE_UNKNOWN_ROOM, 'unknown room')
          }
          const room = getRoom(c.room)
          if (!room) {
            ws.send(JSON.stringify({ t: 'error', message: 'The server is full, try again soon.' } satisfies ServerMsg))
            return ws.close(1013, 'full')
          }
          if (room.humans === 0) room.wake()
          const want = typeof msg.faction === 'number' ? Math.floor(msg.faction) : 0
          c.player = room.addPlayer(name, want, {
            send: (d) => void ws.send(d),
            buffered: () => ws.getBufferedAmount(),
          })
          c.player.pfp = pfpFid
          room.fillBots()
          ws.send(JSON.stringify({ t: 'welcome', you: c.player.id, faction: c.player.faction, room: room.id, name, verified } satisfies ServerMsg))
          ws.send(JSON.stringify({ t: 'round', phase: room.phase, subdiv: room.planet.subdiv, endsAt: room.endsAt, now: Date.now() } satisfies ServerMsg))
        }
      },
      close(ws: ServerWebSocket<Conn>) {
        const c = ws.data
        c.closed = true
        if (!c.player) return
        const room = rooms.get(c.room)
        room?.removePlayer(c.player.id)
        room?.fillBots()
        c.player = null
      },
    },
  })

  return {
    server,
    rooms,
    stop() {
      clearTimeout(loop)
      clearInterval(sweep)
      worker.terminate()
      server.stop(true)
      store.close()
    },
  }
}

if (import.meta.main) {
  const s = start()
  console.log(`divide listening on :${s.server.port}`)
}
