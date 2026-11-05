import './style.css'
import * as THREE from 'three'
import { FACTIONS, GAME_NAME, emblemSvg, faction } from '../shared/factions'
import { FONT, wordmark, wordmarkHeight } from '../shared/keyart'
import { planet } from '../shared/planet'
import { FLAG_BOT, packTile, type Battle, type ClientMsg, type ServerMsg, type Standing } from '../shared/protocol'
import { authToken, buzz, cast, fc, initFarcaster, ready } from './fc'
import { Input } from './input'
import { Net } from './net'
import { Scene, loadEarth } from './scene'
import { sound } from './audio'
import { drawCity } from './city'

const WORLD = 'world'
const canvas = document.getElementById('game') as HTMLCanvasElement
const ui = document.getElementById('ui')!
/** replaces the loading screen with an explanation, for browsers that can't run the game */
function fatal(title: string, body: string) {
  const boot = document.getElementById('boot')
  const bar = boot?.querySelector<HTMLElement>('.boot-bar')
  if (bar) bar.style.display = 'none'
  const msg = boot?.querySelector<HTMLElement>('.boot-msg')
  if (msg) {
    msg.style.cssText = 'max-width:min(88vw,420px);text-align:center;color:#d4d8ee'
    msg.innerHTML = `<b style="display:block;color:#fff;font-size:17px;margin-bottom:6px">${title}</b>${body}`
  }
}

let scene: Scene
try {
  scene = new Scene(canvas)
} catch (e) {
  fatal(
    'Your browser has WebGL turned off',
    'The Network Divide draws the Earth with WebGL. In LibreWolf or Firefox with hardened settings, open <code>about:config</code>, set <code>webgl.disabled</code> to <code>false</code> and reload, or play in another browser.',
  )
  throw e
}
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

const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`
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
  counts: FACTIONS.map(() => 0),
  total: 1,
  sizes: FACTIONS.map(() => 0),
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
  const seeds = [[1, 0.6, 0.4], [-1, -0.2, -0.5]].map((v) => new THREE.Vector3(...v).normalize())
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
    tiles[i] = bd > 0.35 ? packTile(best + 1, 0) : 0
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
    <button class="side-card ${pick === f.id ? 'on' : ''}" data-faction="${f.id}" style="--c:${f.color}" aria-pressed="${pick === f.id}">
      <span class="side-emblem">${emblem(f.id, 56)}</span>
      <span class="side-name">${esc(f.name)}</span>
      <span class="side-role">${esc(f.role)}</span>
      <span class="side-tag">${esc(f.tagline)}</span>
      <span class="side-count"><i></i><span data-count="${f.id}">—</span></span>
    </button>`,
  ).join('<span class="vs" aria-hidden="true">VS</span>')
}

const ctaLabel = (lobby: string | null) => {
  const f = faction(pick)
  return lobby ? (f ? `Join the lobby for ${f.name}` : 'Join the lobby') : f ? `Fight for ${f.name}` : 'Join the war'
}

const soundIcon = () =>
  sound.on
    ? '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'

function howSheet() {
  return `<div class="sheet hidden" role="dialog" aria-modal="true" aria-label="How to play">
    <div class="card how">
      <div class="sheet-head"><div class="eyebrow">How to play</div><button class="ghost close-how" aria-label="Close">✕</button></div>
      <ol class="steps">
        <li><b>Leave your land.</b> Step outside your side's territory and you draw a glowing trail behind you.</li>
        <li><b>Come back home.</b> The trail and everything it fences off becomes yours, enemy ground included.</li>
        <li><b>Cut their trails.</b> Cross an enemy's trail to send them back to respawn. Don't stay out too long yourself.</li>
        <li><b>Hold the most.</b> After four minutes the side holding more of the Earth wins the round.</li>
      </ol>
      <div class="muted">Steer by dragging anywhere (phone), pointing with the mouse, or WASD / arrow keys. Pinch or scroll to zoom.</div>
      <div class="credits muted">Music: <a href="https://opengameart.org/content/mist-city" target="_blank" rel="noopener">“Mist City” by Section7</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>. Earth imagery: NASA Blue Marble and Earth at Night (public domain).</div>
    </div>
  </div>`
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
  sound.duck(false)
  attract()
  const lobby = route.kind === 'lobby' ? route.id : null
  const who = fc.user
    ? `<div class="who">${fc.user.pfpUrl ? `<img src="${esc(fc.user.pfpUrl)}" alt="">` : ''}<span>Playing as <b>@${esc(fc.user.username ?? `fid ${fc.user.fid}`)}</b></span></div>`
    : `<label class="nick-wrap"><span class="sr">Nickname</span><input class="nick" maxlength="16" placeholder="Your name (optional)" value="${esc(nick)}" autocomplete="nickname"></label>`
  ui.innerHTML = `
  <div class="menu">
    <header class="hero">
      ${titleSvg()}
      <p class="sub">The Farcaster split comes to blows. Pick a side and divide the Earth.</p>
    </header>
    <div class="spacer"></div>
    <section class="panel">
      <div id="battle-slot"></div>
      ${lobby ? `<div class="lobby-badge"><span class="eyebrow">Private lobby</span><b>${esc(lobby)}</b><button class="ghost invite">Invite</button></div>` : ''}
      <div class="sides">${factionCards()}</div>
      <button class="auto ${pick === 0 ? 'on' : ''}" data-faction="0" aria-pressed="${pick === 0}">${pick === 0 ? '✓ ' : ''}Let the game pick the smaller side</button>
      <div class="go-row">
        ${who}
        <button class="primary play" style="--c:${faction(pick)?.color ?? '#ff7a1a'}">${esc(ctaLabel(lobby))}</button>
      </div>
      <div class="live muted"><i class="dot"></i><span class="live-text">Connecting to the war…</span></div>
      <nav class="tools">
        ${lobby ? '<button class="ghost leave">Back to the big war</button>' : '<button class="ghost new-lobby">Private lobby</button>'}
        <button class="ghost how-toggle">How to play</button>
        <button class="ghost icon sound-toggle" aria-label="Sound">${soundIcon()}</button>
      </nav>
    </section>
    ${howSheet()}
  </div>`
  const cta = ui.querySelector<HTMLElement>('.play')!
  ui.querySelectorAll<HTMLElement>('[data-faction]').forEach((b) =>
    b.addEventListener('click', () => {
      pick = Number(b.dataset.faction)
      save('divide:faction', String(pick))
      sound.unlock()
      sound.play('pick')
      ui.querySelectorAll<HTMLElement>('[data-faction]').forEach((x) => {
        const on = Number(x.dataset.faction) === pick
        x.classList.toggle('on', on)
        x.setAttribute('aria-pressed', String(on))
      })
      const auto = ui.querySelector('.auto')!
      auto.textContent = `${pick === 0 ? '✓ ' : ''}Let the game pick the smaller side`
      cta.textContent = ctaLabel(lobby)
      cta.style.setProperty('--c', faction(pick)?.color ?? '#ff7a1a')
    }),
  )
  cta.addEventListener('click', () => {
    sound.unlock()
    sound.play('start')
    play(lobby ?? WORLD)
  })
  const tap = (sel: string, f: () => void) =>
    ui.querySelector(sel)?.addEventListener('click', () => {
      sound.unlock()
      sound.play('click')
      f()
    })
  tap('.new-lobby', newLobby)
  tap('.invite', () => invite(lobby!))
  tap('.leave', () => go('/'))
  const sheet = ui.querySelector('.sheet')!
  tap('.how-toggle', () => sheet.classList.remove('hidden'))
  tap('.close-how', () => sheet.classList.add('hidden'))
  sheet.addEventListener('click', (e) => e.target === sheet && sheet.classList.add('hidden'))
  const st = ui.querySelector<HTMLElement>('.sound-toggle')!
  st.addEventListener('click', () => {
    sound.toggle()
    st.innerHTML = soundIcon()
    sound.play('click')
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
    const live = ui.querySelector('.live-text')
    const sizes: number[] = r.live ? r.sizes : FACTIONS.map(() => 0)
    for (const f of FACTIONS) {
      const el = ui.querySelector(`[data-count="${f.id}"]`)
      if (el) el.textContent = `${sizes[f.id - 1]} fighting now`
    }
    if (live) {
      const humans = r.live ? r.humans : 0
      const left = r.live && r.phase === 'play' ? Math.max(0, Math.round((r.endsAt - r.now) / 1000)) : 0
      live.textContent = humans
        ? `${humans} ${humans === 1 ? 'player' : 'players'} in the war${left ? ` · round ends in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : ''}`
        : 'No players online yet. Bots hold the line until you arrive.'
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
  if (room === WORLD) cast('Join the war over the Farcaster split in The Network Divide ⚔️ Pick a side: Quilibrium or Network School.', location.origin)
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
  scene.want = null
  sound.duck(true)
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
        sound.play('cut')
        buzz('success')
      } else if (m.kind === 'died') {
        toast(m.who ? `${m.who} cut your trail` : 'Your trail was cut', 'bad')
        sound.play('died')
        buzz('error')
      } else if (m.kind === 'captured' && m.n) {
        toast(`+${m.n} tiles`, 'good')
        sound.play(m.n > 30 ? 'bigCapture' : 'capture')
        buzz(m.n > 30 ? 'heavy' : 'light')
      }
      break
    case 'end':
      game.phase = 'end'
      game.lastEnd = { battle: m.battle, me: m.me, nextAt: m.nextAt }
      game.skew = Date.now() - m.now
      game.endsAt = m.nextAt
      endScreen()
      sound.play(m.battle.winner === game.faction ? 'win' : 'lose')
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
      .map((s, i) => `<div class="rowp"><span>${i + 1}. <b style="color:${faction(s.faction)?.color}">${esc(s.name)}</b></span><span>${n(s.captured, 'tile')} · ${n(s.cuts, 'cut')}</span></div>`)
      .join('')}${game.me ? `<div class="rowp you"><span>You: #${game.me.rank}</span><span>${n(game.me.captured, 'tile')} · ${n(game.me.cuts, 'cut')}</span></div>` : ''}`
  updateMe()
}

function updateMe() {
  const el = ui.querySelector('.mebar')
  const f = faction(game.faction)
  if (!el || !f) return
  const me = game.me
  el.innerHTML = `<b style="color:${f.color}">${esc(f.name)}</b> · ${esc(game.name)}${me ? ` · ${n(me.captured, 'tile')} · ${n(me.cuts, 'cut')} · #${me.rank}` : ''}`
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
    scene.want = d
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
  const bar = document.querySelector<HTMLElement>('#boot .boot-bar i')
  const msg = document.querySelector<HTMLElement>('#boot .boot-msg')
  if (bar) bar.classList.add('known')
  const setP = (p: number) => bar && (bar.style.width = `${Math.round(15 + p * 85)}%`)
  setP(0)
  if (msg) msg.textContent = 'Mapping the Earth…'
  drawCity()
  // the mini app splash stays up until ready(), so the Earth and the menu are already there behind it
  const [maps] = await Promise.all([loadEarth(setP), initFarcaster()])
  scene.setMaps(maps)
  menu()
  requestAnimationFrame(frame)
  ready()
  const boot = document.getElementById('boot')
  if (boot) {
    boot.classList.add('done')
    setTimeout(() => boot.remove(), 600)
  }
}

boot()
