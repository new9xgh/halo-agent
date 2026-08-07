import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Covers the pure pptx parsing helpers (speaker-notes extraction +
// Content_Types repair). jsdom supplies DOMParser/XMLSerializer with real
// XML-namespace support (the OPC parts are heavily namespaced; happy-dom's
// getAttributeNS can't resolve them).
export default defineConfig({
  resolve: {
    // Mirror tsconfig's `@/*` → `./src/*` so store/api modules resolve in tests.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // tsconfig sets `jsx: preserve` (Next.js owns the JSX transform there);
  // tests import .tsx components directly, so give vite's oxc transform a
  // real JSX mode.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
})
