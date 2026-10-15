// Dev helper: connects to an MCP HTTP endpoint with the official SDK and prints its tools. Usage: node scripts/mcp-probe.mjs <url> [toolName jsonArgs]
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [url, tool, args] = process.argv.slice(2)
const client = new Client({ name: 'freeagent-probe', version: '0.0.1' })
await client.connect(new StreamableHTTPClientTransport(new URL(url)))
if (tool) {
  const r = await client.callTool({ name: tool, arguments: args ? JSON.parse(args) : {} })
  console.log(JSON.stringify(r, null, 1).slice(0, 4000))
} else {
  const { tools } = await client.listTools()
  console.log('tools:', tools.length)
  for (const t of tools) console.log('-', t.name, '|', (t.description ?? '').replace(/\s+/g, ' ').slice(0, 110))
}
await client.close()
process.exit(0)
