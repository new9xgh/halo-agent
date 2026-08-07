import type { WsClient } from './ws-client-types'

/**
 * Run `callback` on every WS *re*connect — never on a subscriber's first
 * connect.
 *
 * Why: several panels keep state in sync purely by incremental `file:changed`
 * deltas. Events emitted while the socket was down (laptop lid, network drop)
 * are lost forever, leaving that state stale until the next unrelated event —
 * or indefinitely when none comes. Each such subscriber pairs its delta
 * subscription with `onWsReconnect(wsClient, <its existing refetch>)` so a
 * reconnect reconciles against the server instead of trusting the gap.
 *
 * `everConnected` seeds from the client's live state: a subscriber mounting on
 * an already-open socket (panel opened mid-session) must treat the next
 * `_connected` as a reconnect, while a page-load mount (socket still
 * connecting) must NOT fire on its first `_connected` — the subscriber's own
 * mount fetch has that covered, and firing would be a pure double-pull.
 */
export function onWsReconnect(client: WsClient, callback: () => void): () => void {
  let everConnected = client.connected
  return client.on('_connected', () => {
    if (!everConnected) {
      everConnected = true
      return
    }
    callback()
  })
}
