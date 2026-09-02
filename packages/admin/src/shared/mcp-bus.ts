'use client'

import { create } from 'zustand'

/**
 * Tiny bus for "MCP server list changed" signals.
 *
 * Same shape as agent-bus / skill-bus. The MCP management view subscribes to
 * `version` and re-fetches when it changes. Any place that mutates MCP servers
 * (create, delete, external file events) calls `bump()`.
 */
interface McpBus {
  version: number
  bump(): void
}

export const useMcpBus = create<McpBus>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))

export function bumpMcpBus() {
  useMcpBus.getState().bump()
}
