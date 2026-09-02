/**
 * Minimal fake MCP server for tests — newline-delimited JSON-RPC over
 * stdin/stdout, hand-rolled (no SDK) so the fixture exercises the real
 * protocol surface the client depends on: initialize → tools/list →
 * tools/call. Notifications (no `id`) are ignored.
 *
 * Tools:
 *   echo   — returns `echo:<text>` as a text block
 *   boom   — returns isError: true
 *   lookup — annotated readOnlyHint: true (for readonly-session tests)
 */

function respond(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id === undefined || msg.id === null) continue // notification
    if (msg.method === 'initialize') {
      respond({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '0.0.1' },
        },
      })
    } else if (msg.method === 'ping') {
      respond({ jsonrpc: '2.0', id: msg.id, result: {} })
    } else if (msg.method === 'tools/list') {
      respond({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo back the input text',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
            {
              name: 'boom',
              description: 'Always fails',
              inputSchema: { type: 'object', properties: {} },
            },
            {
              name: 'lookup',
              description: 'Read-only lookup',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      })
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name
      if (name === 'echo') {
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `echo:${msg.params?.arguments?.text ?? ''}` }] },
        })
      } else if (name === 'boom') {
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'kaboom' }], isError: true },
        })
      } else if (name === 'lookup') {
        respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'found' }] },
        })
      } else {
        respond({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown tool "${name}"` } })
      }
    } else {
      respond({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method "${msg.method}"` } })
    }
  }
})
