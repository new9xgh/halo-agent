import { defineConfig } from 'vitest/config'

// Tests cover the externally-fixed contracts that fail silently if they
// regress: on-disk session format, the Anthropic message-array invariants,
// and the agent-event → WS-message mapping. See test/*.test.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
