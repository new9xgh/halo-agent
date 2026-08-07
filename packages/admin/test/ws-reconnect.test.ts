import { describe, it, expect, vi } from 'vitest'
import { onWsReconnect } from '../src/shared/ws-reconnect'
import type { WsClient } from '../src/shared/ws-client-types'

/**
 * Contract: `onWsReconnect` fires its callback on every WS *re*connect, never
 * on the subscriber's first connect (the subscriber's own mount fetch owns
 * that — firing would double-pull). "First" is relative to the subscriber:
 * the ever-connected flag seeds from the client's live state, so a subscriber
 * mounting on an already-open socket treats the next `_connected` as a
 * reconnect.
 *
 * Same fake-client pattern as file-tree-reconnect.test.ts: the helper receives
 * the client as a parameter (`WsClient` is structural), so the test drives the
 * real subscription, not a copy of its logic.
 */

type Handler = (data: Record<string, unknown>) => void

function makeFakeWsClient(connected: boolean): { client: WsClient; emit: (type: string) => void } {
  const handlers = new Map<string, Handler[]>()
  const client = {
    connected,
    on(type: string, handler: Handler) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
      return () => {
        const cur = handlers.get(type) ?? []
        handlers.set(type, cur.filter((h) => h !== handler))
      }
    },
  } as unknown as WsClient
  return {
    client,
    emit: (type) => (handlers.get(type) ?? []).forEach((h) => h({})),
  }
}

describe('onWsReconnect', () => {
  it('page-load subscribe (not yet connected): first _connected does not fire, second does', () => {
    const cb = vi.fn()
    const { client, emit } = makeFakeWsClient(false)

    const unsub = onWsReconnect(client, cb)

    emit('_connected')
    expect(cb).not.toHaveBeenCalled()

    emit('_connected')
    expect(cb).toHaveBeenCalledTimes(1)

    // Every subsequent reconnect fires again — the gate only eats the first.
    emit('_connected')
    expect(cb).toHaveBeenCalledTimes(2)
    unsub()
  })

  it('subscribe on an already-open socket: the next _connected IS a reconnect', () => {
    const cb = vi.fn()
    const { client, emit } = makeFakeWsClient(true)

    const unsub = onWsReconnect(client, cb)

    emit('_connected')
    expect(cb).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('unsubscribe stops the callback (subscriber unmounted)', () => {
    const cb = vi.fn()
    const { client, emit } = makeFakeWsClient(true)

    const unsub = onWsReconnect(client, cb)
    unsub()

    emit('_connected')
    expect(cb).not.toHaveBeenCalled()
  })

  it('unrelated events never fire the callback', () => {
    const cb = vi.fn()
    const { client, emit } = makeFakeWsClient(true)

    const unsub = onWsReconnect(client, cb)

    emit('_disconnected')
    emit('file:changed')
    expect(cb).not.toHaveBeenCalled()
    unsub()
  })
})
