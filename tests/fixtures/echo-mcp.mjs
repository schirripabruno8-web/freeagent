// The smallest stdio MCP server: one tool, no state. Used to try "add a server from the app" without downloading anything.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo', version: '1.0.0' })
server.tool('echo', 'Returns the text it is given', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text }] }))
await server.connect(new StdioServerTransport())
