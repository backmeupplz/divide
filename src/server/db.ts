import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Battle } from '../shared/protocol'

export type Store = {
  saveBattle(b: Battle): void
  battle(id: string): Battle | null
  /** issued lobby ids and when they expire, so invites survive a restart or deploy */
  saveLobby(id: string, expires: number): void
  dropLobby(id: string): void
  lobbies(now: number): [string, number][]
  close(): void
}

export function openStore(dir = process.env.DATA_DIR ?? './data'): Store {
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'divide.sqlite'), { create: true })
  // a rolling deploy runs the old and the new container on the same file for a moment
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS battles (id TEXT PRIMARY KEY, room TEXT NOT NULL, ended_at INTEGER NOT NULL, data TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS lobbies (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)')
  const putLobby = db.prepare('INSERT OR REPLACE INTO lobbies (id, expires) VALUES (?, ?)')
  const delLobby = db.prepare('DELETE FROM lobbies WHERE id = ?')
  const listLobbies = db.prepare<{ id: string; expires: number }, [number]>('SELECT id, expires FROM lobbies WHERE expires >= ?')
  const insert = db.prepare('INSERT OR REPLACE INTO battles (id, room, ended_at, data) VALUES (?, ?, ?, ?)')
  const select = db.prepare<{ data: string }, [string]>('SELECT data FROM battles WHERE id = ?')
  return {
    saveBattle(b) {
      insert.run(b.id, b.room, b.endedAt, JSON.stringify(b))
    },
    battle(id) {
      const row = select.get(id)
      return row ? (JSON.parse(row.data) as Battle) : null
    },
    saveLobby(id, expires) {
      putLobby.run(id, expires)
    },
    dropLobby(id) {
      delLobby.run(id)
    },
    lobbies(now) {
      return listLobbies.all(now).map((r) => [r.id, r.expires])
    },
    close() {
      db.close()
    },
  }
}
