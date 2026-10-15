import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export type McpTarget =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string }

export interface ToolInfo {
  name: string
  description: string
  inputSchema: unknown
}

/** `transient` = the connection (or a busy backend) failed, not the tool: retrying later can work. */
export class McpCallError extends Error {
  constructor(
    message: string,
    readonly transient: boolean
  ) {
    super(message)
    this.name = 'McpCallError'
  }
}

const TRANSIENT = /\bbusy\b|ECONN|connection (refused|closed|reset|lost)|socket hang up|EPIPE|not connected|closed the connection/i

function resultText(r: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = []
  for (const c of Array.isArray(r.content) ? (r.content as Record<string, unknown>[]) : []) {
    if (c['type'] === 'text' && typeof c['text'] === 'string') parts.push(c['text'])
    else if (c['type'] === 'image') parts.push('[image omitted: the agent works with text only]')
    else if (c['type'] === 'resource') parts.push(JSON.stringify(c['resource']))
    else parts.push(JSON.stringify(c))
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent))
  return parts.join('\n')
}

/** One MCP session over the official SDK. */
export class McpConnection {
  private constructor(private readonly client: Client) {}

  static async open(t: McpTarget, timeoutMs = 60_000): Promise<McpConnection> {
    const client = new Client({ name: 'freeagent', version: '0.1.0' })
    const transport =
      t.kind === 'stdio'
        ? new StdioClientTransport({ command: t.command, args: t.args, env: t.env, cwd: t.cwd })
        : new StreamableHTTPClientTransport(new URL(t.url))
    try {
      await client.connect(transport, { timeout: timeoutMs })
    } catch (e) {
      await client.close().catch(() => undefined)
      throw new McpCallError(`cannot connect: ${(e as Error).message}`, true)
    }
    return new McpConnection(client)
  }

  async tools(): Promise<ToolInfo[]> {
    const out: ToolInfo[] = []
    let cursor: string | undefined
    do {
      const r = await this.client.listTools(cursor ? { cursor } : undefined)
      for (const t of r.tools) out.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema })
      cursor = r.nextCursor
    } while (cursor)
    return out
  }

  async call(name: string, args: Record<string, unknown>, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
    let r
    try {
      r = await this.client.callTool({ name, arguments: args }, undefined, { signal: o.signal, timeout: o.timeoutMs })
    } catch (e) {
      const msg = (e as Error).message
      throw new McpCallError(msg, TRANSIENT.test(msg))
    }
    const text = resultText(r as { content?: unknown; structuredContent?: unknown })
    if (r.isError) throw new McpCallError(text || 'the tool reported an error', TRANSIENT.test(text))
    return text
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined)
  }
}
