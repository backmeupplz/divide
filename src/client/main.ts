import './style.css'
import * as THREE from 'three'
import { FACTIONS, GAME_NAME, emblemSvg, faction } from '../shared/factions'
import { FONT, wordmark, wordmarkHeight } from '../shared/keyart'
import { planet } from '../shared/planet'
import { FLAG_BOT, packTile, type Battle, type ClientMsg, type ServerMsg, type Standing } from '../shared/protocol'
import { authToken, buzz, cast, fc, initFarcaster, ready } from './fc'
import { Input } from './input'
import { Net } from './net'
import { Scene } from './scene'
import { drawCity } from './city'

const WORLD = 'world'
const canvas = document.getElementById('game') as HTMLCanvasElement
const ui = document.getElementById('ui')!
const scene = new Scene(canvas)
const input = new Input(canvas)
input.onZoom = (f) => (scene.zoom = Math.min(2.2, Math.max(0.55, scene.zoom * f)))

type Route = { kind: 'home' } | { kind: 'lobby'; id: string } | { kind: 'battle'; id: string }
let route: Route = parseRoute()
// storage throws in sandboxed frames and with blocked site data; the game must still boot
const load = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {}
}
let pick = Number(load('divide:faction') ?? 0) || 0
let nick = load('divide:nick') ?? ''

type Me = { captured: number; cuts: number; deaths: number; rank: number }
const game = {
  net: null as Net | null,
  room: WORLD,
  you: 0,
  faction: 0,
  name: '',
  phase: 'play' as 'play' | 'end',
  endsAt: 0,
  skew: 0,
  counts: [0, 0, 0, 0],
  total: 1,
  sizes: [0, 0, 0, 0],
  top: [] as Standing[],
  me: null as Me | null,
  names: new Map<number, string>(),
  bots: new Set<number>(),
  lastEnd: null as { battle: Battle; me: Me | null; nextAt: number } | null,
}

function parseRoute(): Route {
  const m = location.pathname.match(/^\/(lobby|battle)\/([a-z0-9]+)\/?$/)
  if (m) return { kind: m[1] as 'lobby' | 'battle', id: m[2] }
  return { kind: 'home' }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const pct = (n: number, total: number) => (total ? (n / total) * 100 : 0)
const serverNow = () => Date.now() - game.skew

// ---------- attract mode: a slowly turning planet behind the menu ----------

function attract() {
  const n = 14
  const pl = planet(n)
  const tiles = new Uint8Array(pl.count)
  const seeds = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]].map((v) => new THREE.Vector3(...v).normalize())
  for (let i = 0; i < pl.count; i++) {
    const p = new THREE.Vector3(pl.pos[i * 3], pl.pos[i * 3 + 1], pl.pos[i * 3 + 2])
    let best = -1, bd = -2
    seeds.forEach((s, k) => {
      const d = p.dot(s) + 0.25 * Math.sin(i * 1.7)
      if (d > bd) {
        bd = d
        best = k
      }
    })
    tiles[i] = bd > 0.45 ? packTile(best + 1, 0) : 0
  }
  scene.setPlanet(n, tiles)
  scene.crack = 0.6
  scene.me = -1
  scene.resetTimeline()
  scene.attract = true
  document.body.classList.remove('playing')
}

const emblem = (id: number, size: number) => emblemSvg(id, size, FONT)

/** the title treatment as inline SVG, the same one the share images use */
const titleSvg = () =>
  `<svg class="title" viewBox="-280 -6 560 ${wordmarkHeight(100) + 16}" role="img" aria-label="${GAME_NAME}">${wordmark(0, 0, 100, 'mtitle')}</svg>`

// ---------- screens ----------

function factionCards() {
  return FACTIONS.map(
    (f) => `
    <button class="fcard ${pick === f.id ? 'on' : ''}" data-faction="${f.id}" style="--c:${f.color}">
      <span class="fhead">${emblem(f.id, 30)}<span><span class="fname">${esc(f.name)}</span><span class="frole">${esc(f.role)}</span></span></span>
      <span class="ftag">${esc(f.tagline)}</span>
      <span class="fcount" data-count="${f.id}"></span>
    </button>`,
  ).join('')
}

function barsHtml(counts: number[], total: number) {
  return `<div class="bars">${FACTIONS.map((f, i) => {
    const p = pct(counts[i], total)
    return `<div class="bar"><div class="bl"><span>${esc(f.name)}</span><b style="color:${f.color}">${p.toFixed(1)}%</b></div><div class="bt"><i style="width:${Math.max(2, p)}%;background:${f.color}"></i></div></div>`
  }).join('')}</div>`
}

function battleCard(b: Battle) {
  const w = faction(b.winner)!
  const mvp = b.top[0]
  return `<div class="card battle">
    <div class="eyebrow">Battle result</div>
    <h2 style="color:${w.color}">${emblem(w.id, 30)} ${esc(w.name)} won</h2>
    ${barsHtml(b.counts, b.tiles)}
    <div class="muted">${b.players} players${mvp ? ` · MVP ${esc(mvp.name)} with ${mvp.captured} tiles` : ''}</div>
  </div>`
}

function menu() {
  input.enabled = false
  game.net?.close()
  game.net = null
  attract()
  const lobby = route.kind === 'lobby' ? route.id : null
  const who = fc.user
    ? `<div class="who">${fc.user.pfpUrl ? `<img src="${esc(fc.user.pfpUrl)}" alt="">` : ''}<span>Playing as <b>@${esc(fc.user.username ?? `fid ${fc.user.fid}`)}</b></span></div>`
    : `<input class="nick" maxlength="16" placeholder="Nickname (optional)" value="${esc(nick)}">`
  ui.innerHTML = `
  <div class="menu">
    ${titleSvg()}
    <div class="sub">The Farcaster split, fought street by street. Pick a side and take the network.</div>
    <div id="battle-slot"></div>
    ${lobby ? `<div class="lobby-badge">Private lobby <b>${esc(lobby)}</b></div>` : ''}
    <nav class="items">
      <button class="mi play">${lobby ? 'Join the lobby' : 'Play'}</button>
      ${lobby ? '<button class="mi invite">Invite on Farcaster</button><button class="mi leave">Back to the big war</button>' : '<button class="mi new-lobby">Create a private lobby</button>'}
      <button class="mi how-toggle" aria-expanded="false">How to play</button>
    </nav>
    <div class="how hidden">
      <p>Leave your side's territory to draw a trail, then come back home: the trail and everything it encloses becomes yours. An enemy crossing your trail cuts it and sends you back to respawn, so don't stay out too long.</p>
      <p>Steer with a finger (drag anywhere), the mouse, WASD or the arrow keys. The side holding the most of the network when the clock runs out wins the round, and the ground cracks along the front lines as time runs down.</p>
    </div>
    <div class="pick-label">Choose your side</div>
    <div class="factions">${factionCards()}</div>
    <button class="auto ${pick === 0 ? 'on' : ''}" data-faction="0">Auto-balance: put me on the smallest side</button>
    ${who}
  </div>`
  ui.querySelectorAll<HTMLElement>('[data-faction]').forEach((b) =>
    b.addEventListener('click', () => {
      pick = Number(b.dataset.faction)
      save('divide:faction', String(pick))
      ui.querySelectorAll('[data-faction]').forEach((x) => x.classList.toggle('on', Number((x as HTMLElement).dataset.faction) === pick))
    }),
  )
  ui.querySelector('.play')!.addEventListener('click', () => play(lobby ?? WORLD))
  ui.querySelector('.new-lobby')?.addEventListener('click', newLobby)
  ui.querySelector('.invite')?.addEventListener('click', () => invite(lobby!))
  ui.querySelector('.leave')?.addEventListener('click', () => go('/'))
  const how = ui.querySelector('.how-toggle')!
  how.addEventListener('click', () => {
    const open = ui.querySelector('.how')!.classList.toggle('hidden') === false
    how.setAttribute('aria-expanded', String(open))
  })
  if (route.kind === 'battle') showBattle(route.id)
  liveCounts(lobby ?? WORLD)
}

async function showBattle(id: string) {
  try {
    const r = await fetch(`/api/battle/${id}`)
    if (!r.ok) return
    const b = (await r.json()) as Battle
    const slot = document.getElementById('battle-slot')
    if (slot) slot.innerHTML = battleCard(b)
  } catch {}
}

async function liveCounts(room: string) {
  try {
    const r = await (await fetch(`/api/room/${room}`)).json()
    if (!r.live) return
    for (const f of FACTIONS) {
      const el = ui.querySelector(`[data-count="${f.id}"]`)
      if (el) el.textContent = `${r.sizes[f.id - 1]} fighting`
    }
  } catch {}
}

function go(path: string) {
  history.pushState(null, '', path)
  route = parseRoute()
  menu()
}

window.addEventListener('popstate', () => {
  route = parseRoute()
  menu()
})

async function newLobby() {
  const r = await fetch('/api/lobby', { method: 'POST' })
  if (!r.ok) return toast('Could not create a lobby right now')
  const { id } = await r.json()
  go(`/lobby/${id}`)
}

function invite(room: string) {
  if (room === WORLD) cast('Join the war over the Farcaster split in The Network Divide ⚔️ Pick a side: Quilibrium, Network School, Hypersnap or Snapchain.', location.origin)
  else cast(`Join my Network Divide lobby and pick a side in the Farcaster split ⚔️`, `${location.origin}/lobby/${room}`)
}

function castResult() {
  const e = game.lastEnd
  if (!e) return
  const mine = faction(game.faction)
  const w = faction(e.battle.winner)!
  const share = e.me ? pct(e.me.captured, e.battle.tiles).toFixed(1) : '0'
  const won = e.battle.winner === game.faction
  const text = mine
    ? `I captured ${share}% of the network for ${mine.name} in The Network Divide ⚔️ ${won ? `${mine.name} won the round!` : `${w.name} took the round this time.`}`
    : `${w.name} won a round of The Network Divide ⚔️`
  cast(text, `${location.origin}/battle/${e.battle.id}`)
}

// ---------- playing ----------

function play(room: string) {
  const el = ui.querySelector<HTMLInputElement>('.nick')
  if (el) {
    nick = el.value.trim()
    save('divide:nick', nick)
  }
  // never two connections at once, or the first would linger in the match as a ghost
  game.net?.close()
  game.net = null
  game.room = room
  game.names.clear()
  game.bots.clear()
  game.lastEnd = null
  hud()
  scene.attract = false
  document.body.classList.add('playing')
  input.enabled = true
  input.dir = null
  scene.resetTimeline()
  // a fresh token for every (re)join: Quick Auth tokens are short-lived and the SDK caches valid ones
  const join = async (): Promise<ClientMsg> => ({
    t: 'join',
    faction: pick,
    name: nick || undefined,
    token: (await authToken()) ?? undefined,
  })
  const net: Net = new Net(room, join, {
    msg: onMsg,
    snapshot(subdiv, tiles) {
      scene.setPlanet(subdiv, tiles)
    },
    tick(t) {
      for (const d of t.tiles) scene.setTile(d.idx, d.b)
      for (const p of t.players) if (p.flags & FLAG_BOT) game.bots.add(p.id)
      scene.addTick(t.tick, t.players)
    },
    status(s) {
      if (s === 'gone') {
        // the lobby is gone: the server's error toast says so, then back to the menu
        setTimeout(() => game.net === net && go('/'), 1800)
        return
      }
      const el = document.querySelector('.conn')
      if (!el) return
      el.classList.toggle('hidden', s === 'open')
      el.textContent = s === 'connecting' ? 'Connecting…' : 'Reconnecting…'
    },
  })
  game.net = net
}

function onMsg(m: ServerMsg) {
  switch (m.t) {
    case 'welcome':
      game.you = m.you
      game.faction = m.faction
      game.name = m.name
      scene.me = m.you
      scene.resetTimeline()
      updateMe()
      break
    case 'round':
      game.phase = m.phase
      game.endsAt = m.endsAt
      game.skew = Date.now() - m.now
      if (m.phase === 'play') {
        document.querySelector('.end')?.remove()
        scene.resetTimeline()
      }
      break
    case 'names':
      for (const [id, name] of m.p) game.names.set(id, name)
      break
    case 'score':
      game.counts = m.counts
      game.total = m.total
      game.sizes = m.players
      game.top = m.top
      game.me = m.me
      game.endsAt = m.endsAt
      game.skew = Date.now() - m.now
      updateHud()
      break
    case 'event':
      if (m.kind === 'cut') {
        toast(`You cut ${m.who ?? 'an enemy'}!`, 'good')
        buzz('success')
      } else if (m.kind === 'died') {
        toast(m.who ? `${m.who} cut your trail` : 'Your trail was cut', 'bad')
        buzz('error')
      } else if (m.kind === 'captured' && m.n) {
        toast(`+${m.n} tiles`, 'good')
        buzz(m.n > 30 ? 'heavy' : 'light')
      }
      break
    case 'end':
      game.phase = 'end'
      game.lastEnd = { battle: m.battle, me: m.me, nextAt: m.nextAt }
      game.skew = Date.now() - m.now
      game.endsAt = m.nextAt
      endScreen()
      break
    case 'error':
      toast(m.message, 'bad')
      break
  }
}

function hud() {
  // the old HUD's name tags go with it
  labelPool.length = 0
  ui.innerHTML = `
  <div class="hud">
    <div class="top">
      <div class="timer">4:00</div>
      <div class="meter">
        <div class="score">${FACTIONS.map((f) => `<i data-seg="${f.id}" style="background:${f.color}"></i>`).join('')}</div>
        <div class="legend">${FACTIONS.map((f) => `<span data-leg="${f.id}" style="color:${f.color}">${f.short} 0%</span>`).join('')}</div>
      </div>
    </div>
    <div class="side">
      <button class="share" title="Invite">Invite</button>
      <button class="lb" title="Leaderboard">Top</button>
      <button class="exit" title="Leave">✕</button>
    </div>
    <div class="board hidden"></div>
    <div class="toasts"></div>
    <div class="mebar"></div>
    <div class="conn hidden">Reconnecting…</div>
    <div class="labels"></div>
  </div>`
  ui.querySelector('.share')!.addEventListener('click', () => invite(game.room))
  ui.querySelector('.lb')!.addEventListener('click', () => ui.querySelector('.board')!.classList.toggle('hidden'))
  ui.querySelector('.exit')!.addEventListener('click', () => menu())
}

function updateHud() {
  const total = game.total || 1
  for (const f of FACTIONS) {
    const p = pct(game.counts[f.id - 1], total)
    const seg = ui.querySelector<HTMLElement>(`[data-seg="${f.id}"]`)
    if (seg) seg.style.width = `${p}%`
    const leg = ui.querySelector(`[data-leg="${f.id}"]`)
    if (leg) leg.textContent = `${f.short} ${p.toFixed(1)}%`
  }
  const board = ui.querySelector('.board')
  if (board)
    board.innerHTML = `<div class="eyebrow">Top players</div>${game.top
      .map((s, i) => `<div class="rowp"><span>${i + 1}. <b style="color:${faction(s.faction)?.color}">${esc(s.name)}</b></span><span>${s.captured} tiles · ${s.cuts} cuts</span></div>`)
      .join('')}${game.me ? `<div class="rowp you"><span>You: #${game.me.rank}</span><span>${game.me.captured} tiles · ${game.me.cuts} cuts</span></div>` : ''}`
  updateMe()
}

function updateMe() {
  const el = ui.querySelector('.mebar')
  const f = faction(game.faction)
  if (!el || !f) return
  const me = game.me
  el.innerHTML = `<b style="color:${f.color}">${esc(f.name)}</b> · ${esc(game.name)}${me ? ` · ${me.captured} tiles · ${me.cuts} cuts · #${me.rank}` : ''}`
}

function endScreen() {
  const e = game.lastEnd
  if (!e) return
  document.querySelector('.end')?.remove()
  const w = faction(e.battle.winner)!
  const won = e.battle.winner === game.faction
  const div = document.createElement('div')
  div.className = 'end'
  div.innerHTML = `<div class="card">
    <div class="eyebrow">Round over</div>
    <h2 style="color:${w.color}">${emblem(w.id, 30)} ${esc(w.name)} won${won ? '!' : ''}</h2>
    ${barsHtml(e.battle.counts, e.battle.tiles)}
    ${e.me ? `<div class="stats"><div><b>${e.me.captured}</b><span>tiles</span></div><div><b>${e.me.cuts}</b><span>cuts</span></div><div><b>${e.me.deaths}</b><span>deaths</span></div><div><b>#${e.me.rank}</b><span>rank</span></div></div>` : ''}
    <button class="primary cast">Cast the result</button>
    <button class="invite2">Invite friends to the next round</button>
    <div class="muted next"></div>
  </div>`
  ui.appendChild(div)
  div.querySelector('.cast')!.addEventListener('click', castResult)
  div.querySelector('.invite2')!.addEventListener('click', () => invite(game.room))
}

let toastN = 0
function toast(text: string, kind: 'good' | 'bad' | '' = '') {
  const box = ui.querySelector('.toasts') ?? ui
  const t = document.createElement('div')
  t.className = `toast ${kind}`
  t.textContent = text
  box.appendChild(t)
  const n = ++toastN
  setTimeout(() => t.remove(), 2200)
  while (box.querySelectorAll('.toast').length > 3 && n) box.querySelector('.toast')?.remove()
}

// ---------- frame loop ----------

const labelPool: HTMLElement[] = []
let lastSec = -1

function resize() {
  scene.resize(window.innerWidth, window.innerHeight)
}
window.addEventListener('resize', resize)
resize()

function frame() {
  requestAnimationFrame(frame)
  const w = window.innerWidth, h = window.innerHeight
  if (!game.net) {
    // attract mode: the scene turns the planet by itself
    scene.frame()
    return
  }
  const remaining = Math.max(0, game.endsAt - serverNow())
  if (game.phase === 'play') scene.crack = Math.min(1, Math.max(0, 1 - remaining / (4 * 60 * 1000)))
  const sec = Math.ceil(remaining / 1000)
  if (sec !== lastSec) {
    lastSec = sec
    const t = document.querySelector('.timer')
    if (t) t.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
    const next = document.querySelector('.end .next')
    if (next) next.textContent = `Next round in ${sec}s`
  }
  scene.frame()
  // steering
  const me = scene.drawn.get(game.you)
  if (me) {
    const s = scene.project(me.pos, w, h)
    if (s) input.anchor = s
  }
  if (input.dir && game.net) {
    const d = scene.worldDir(input.dir.x, input.dir.y)
    game.net.dir(d.x, d.y, d.z)
  }
  labels(w, h)
}

function labels(w: number, h: number) {
  const box = ui.querySelector('.labels') as HTMLElement | null
  if (!box) return
  const mePos = scene.playerPos
  const near = [...scene.drawn.entries()]
    .filter(([, d]) => d.alive)
    .sort((a, b) => b[1].pos.dot(mePos) - a[1].pos.dot(mePos))
    .slice(0, 10)
  let i = 0
  for (const [id, d] of near) {
    const s = scene.project(d.pos, w, h)
    if (!s) continue
    let el = labelPool[i]
    if (!el) {
      el = document.createElement('div')
      el.className = 'tag'
      box.appendChild(el)
      labelPool[i] = el
    }
    const name = id === game.you ? 'you' : (game.names.get(id) ?? '')
    if (el.textContent !== name) el.textContent = name
    el.style.transform = `translate(${s.x.toFixed(0)}px, ${s.y.toFixed(0)}px) translate(-50%, -140%)`
    el.style.color = faction(d.faction)?.color ?? '#fff'
    el.style.display = ''
    i++
  }
  for (; i < labelPool.length; i++) labelPool[i].style.display = 'none'
}

// for poking at a running game from the browser console
Object.assign(window, { divide: { scene, game } })

async function boot() {
  drawCity()
  await initFarcaster()
  menu()
  ready()
  requestAnimationFrame(frame)
}

boot()
