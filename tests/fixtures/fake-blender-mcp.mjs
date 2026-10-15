// The thin stdio MCP server in front of the fake backend, like blender-mcp in front of the Blender add-on:
// it opens ONE persistent connection to the backend, lazily, on the first tool call.
// Usage: node fake-blender-mcp.mjs <backend-port>
import net from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const port = Number(process.argv[2])
let conn // the connection PROMISE: two first calls at once must share one connection, not open two
let seq = 0
const waiting = new Map()

function connect() {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    let buf = ''
    s.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        if (m.id === 0) return reject(new Error(m.error)) // the backend refused this connection
        waiting.get(m.id)?.(m)
        waiting.delete(m.id)
      }
    })
    s.on('connect', () => setTimeout(() => resolve(s), 30)) // give a "busy" greeting time to arrive
    s.on('error', reject)
    s.on('close', () => reject(new Error('backend closed the connection')))
  })
}

import { existsSync, writeFileSync } from 'node:fs'

async function send(cmd, args) {
  // Simulated flaky connection: the very first call EVER (marker file absent) fails like a refused connection.
  const marker = process.env.FAKE_FAIL_MARKER
  if (marker && !existsSync(marker)) {
    writeFileSync(marker, '1')
    throw new Error('ECONNREFUSED (simulated): the backend is not accepting connections')
  }
  conn ??= connect()
  const sock = await conn
  const id = ++seq
  return new Promise((resolve, reject) => {
    waiting.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.result)))
    sock.write(JSON.stringify({ id, cmd, args }) + '\n')
  })
}

const server = new McpServer({ name: 'fake-blender', version: '0.0.1' })
const tool = (name, description, shape, cmd) =>
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return { content: [{ type: 'text', text: String(await send(cmd, args)) }] }
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] }
    }
  })
tool('create_object', 'Create an object', { name: z.string() }, 'create')
tool('select_object', 'Make an object the active one (global state)', { name: z.string() }, 'select')
tool('scale_active', 'Scale the ACTIVE object', { factor: z.number() }, 'scale_active')
tool('get_object', 'Read an object', { name: z.string() }, 'get')
await server.connect(new StdioServerTransport())
