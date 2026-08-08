import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  output: 'export',
  // Repo and ~/ both carry lockfiles; pin the trace root to this monorepo so
  // Next.js stops inferring ~/package-lock.json as the workspace root.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // Strip console.* from production chunks (perf audit P1-1): several hot-path
  // console.debug calls evaluate template args — two even capture
  // `new Error().stack` — on every message/stream event. SWC drops the whole
  // call expression, arguments included. error/warn stay for field debugging.
  compiler: {
    removeConsole: { exclude: ['error', 'warn'] },
  },
  // Dev mode: proxy API requests to Hono server
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:9527/api/:path*',
      },
      {
        source: '/ws',
        destination: 'http://localhost:9527/ws',
      },
    ]
  },
}

export default nextConfig
