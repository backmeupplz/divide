import { MSG_SNAPSHOT, MSG_TICK, decodeSnapshot, decodeTick, type ClientMsg, type ServerMsg, type Tick } from '../shared/protocol'

export type Handlers = {
  msg(m: ServerMsg): void
  snapshot(subdiv: number, tiles: Uint8Array): void
  tick(t: Tick): void
  /** 'gone' means the room doesn't exist (any more) and the connection gave up */
  status(s: 'connecting' | 'reconnecting' | 'open' | 'closed' | 'gone'): void
}

/** the server's close code for a room that does not exist */
const CLOSE_UNKNOWN_ROOM = 4404

/** one game connection; it reconnects and joins again by itself when the socket drops */
export class Net {
  private ws: WebSocket | null = null
  private stopped = false
  private retry = 0
  private opened = false
  private lastDir = 0

  constructor(
    private room: string,
    private join: () => Promise<ClientMsg>,
    private h: Handlers,
  ) {
    this.connect()
  }

  private connect() {
    if (this.stopped) return
    this.h.status(this.opened ? 'reconnecting' : 'connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(this.room)}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = async () => {
      this.retry = 0
      this.opened = true
      const join = await this.join()
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(join))
      this.h.status('open')
    }
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        this.h.msg(JSON.parse(e.data) as ServerMsg)
        return
      }
      const bytes = new Uint8Array(e.data as ArrayBuffer)
      if (bytes[0] === MSG_TICK) this.h.tick(decodeTick(bytes))
      else if (bytes[0] === MSG_SNAPSHOT) {
        const s = decodeSnapshot(bytes)
        this.h.snapshot(s.subdiv, s.tiles)
      }
    }
    ws.onclose = (e) => {
      if (e.code === CLOSE_UNKNOWN_ROOM) {
        this.stopped = true
        this.h.status('gone')
        return
      }
      this.h.status('closed')
      if (this.stopped) return
      setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** this.retry++))
    }
  }

  /** sends the wanted direction, at most ~15 times a second */
  dir(x: number, y: number, z: number, force = false) {
    const now = performance.now()
    if (!force && now - this.lastDir < 66) return
    this.lastDir = now
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'dir', x: +x.toFixed(4), y: +y.toFixed(4), z: +z.toFixed(4) }))
  }

  close() {
    this.stopped = true
    this.ws?.close()
  }
}
