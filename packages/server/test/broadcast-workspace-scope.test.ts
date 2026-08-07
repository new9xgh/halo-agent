import { describe, it, expect, beforeEach } from 'vitest'
import type { WebSocket, WebSocketServer } from 'ws'
import {
  broadcast,
  broadcastToWorkspace,
  setBroadcastWss,
  setClientWorkspaceResolver,
} from '../src/ws/broadcast.js'

/**
 * C-L1 contract: git writes push `file:changed` only to the tabs showing that
 * workspace. The unconditional broadcast made every other connected browser
 * refetch status + ignored + log for a workspace that didn't change.
 *
 * Fake sockets: broadcast only needs `readyState`, `OPEN` and `send`.
 */
type FakeSocket = { readyState: number; OPEN: number; sent: string[]; send: (p: string) => void }

function socket(open = true): FakeSocket {
  const s: FakeSocket = {
    OPEN: 1,
    readyState: open ? 1 : 3,
    sent: [],
    send(p: string) { s.sent.push(p) },
  }
  return s
}

function installWss(sockets: FakeSocket[]): void {
  setBroadcastWss({ clients: new Set(sockets) } as unknown as WebSocketServer)
}

const event = { type: 'file:changed', path: '.git', action: 'change' }

describe('broadcastToWorkspace', () => {
  beforeEach(() => {
    setClientWorkspaceResolver(() => null)
  })

  it('sends only to clients bound to the target workspace', () => {
    const a = socket(), b = socket(), c = socket()
    const bind = new Map<FakeSocket, string | null>([[a, '/ws/alpha'], [b, '/ws/beta'], [c, null]])
    installWss([a, b, c])
    setClientWorkspaceResolver((ws) => bind.get(ws as unknown as FakeSocket) ?? null)

    broadcastToWorkspace('/ws/alpha', event)

    expect(a.sent).toHaveLength(1)
    expect(JSON.parse(a.sent[0])).toEqual(event)
    expect(b.sent).toHaveLength(0) // other workspace — no refetch storm
    expect(c.sent).toHaveLength(0) // not bound to any workspace yet
  })

  it('normalizes trailing separators / non-canonical paths on both sides', () => {
    const a = socket()
    installWss([a])
    setClientWorkspaceResolver(() => '/ws/alpha/')

    broadcastToWorkspace('/ws/alpha', event)
    expect(a.sent).toHaveLength(1)

    broadcastToWorkspace('/ws/alpha/./', event)
    expect(a.sent).toHaveLength(2)

    broadcastToWorkspace('/ws/alpha-secret', event) // segment-boundary, not prefix
    expect(a.sent).toHaveLength(2)
  })

  it('skips sockets that are not OPEN', () => {
    const dead = socket(false)
    installWss([dead])
    setClientWorkspaceResolver(() => '/ws/alpha')

    broadcastToWorkspace('/ws/alpha', event)
    expect(dead.sent).toHaveLength(0)
  })

  it('falls back to a global broadcast when no resolver is registered', () => {
    const a = socket(), b = socket()
    installWss([a, b])
    setClientWorkspaceResolver(null as unknown as (ws: WebSocket) => string | null)

    broadcastToWorkspace('/ws/alpha', event)
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
  })

  it('plain broadcast still reaches everyone', () => {
    const a = socket(), b = socket()
    installWss([a, b])
    setClientWorkspaceResolver(() => '/ws/alpha')

    broadcast({ type: 'session:changed' })
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
  })
})
