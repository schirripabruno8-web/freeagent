import type { McpCandidate } from '@contracts/mcp'

/** One server as a README or another app shows it. Only what FreeAgent understands is kept. */
type Raw = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** A name the model can type: lowercase letters, digits, - and _, starting with a letter, at most 32 characters. */
export function cleanName(raw: string): string {
  let n = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!n) n = 'server'
  if (!/^[a-z]/.test(n)) n = `mcp-${n}`
  return n.slice(0, 32).replace(/-+$/, '') || 'server'
}

/** A package or host turned into a name. */
export function deriveName(command: string | undefined, args: string[], url?: string): string {
  let base = ''
  if (url) {
    try {
      base = new URL(url).hostname.replace(/^(www|mcp|api)\./, '').split('.')[0] ?? ''
    } catch {
      base = ''
    }
  } else {
    const runner = (command ?? '').split(/[\\/]/).pop()!.replace(/\.(cmd|exe|bat)$/i, '').toLowerCase()
    // npx -y pkg, uvx pkg, pnpm dlx pkg, node server.js: the first argument that is not a flag names it
    const rest = args.filter((a) => !a.startsWith('-'))
    const first = ['npx', 'uvx', 'pnpm', 'bunx', 'pipx'].includes(runner) ? rest.find((a) => a !== 'dlx' && a !== 'run') : rest[0]
    base = (first ?? runner).split(/[\\/]/).pop()!.replace(/\.(js|mjs|cjs|py|ts)$/i, '').replace(/@[\w.^~-]+$/, '')
  }
  return cleanName(base.toLowerCase().replace(/^((server|mcp)[-_])+/, '').replace(/([-_](server|mcp))+$/, ''))
}

/** Shell-like split: spaces separate, "double" and 'single' quotes group, a backslash inside a Windows path is kept as it is. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  let any = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      any = true
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

function fromRaw(name: string | undefined, r: Raw): McpCandidate | string {
  const notes: string[] = []
  const url = str(r['url']) ?? str(r['serverUrl']) ?? str(r['httpUrl'])
  const command = str(r['command'])
  if (!command && !url) return 'needs a "command" (a program to start) or a "url"'
  const t = str(r['type'])?.toLowerCase()
  if (t === 'sse') notes.push('type "sse" is an old transport: it is tried as streamable http')
  if (r['headers'] || r['auth']) notes.push('headers and logins are not supported yet: a server that needs them will refuse')
  const args = Array.isArray(r['args']) ? r['args'].map((a) => String(a)) : []
  const envRaw = r['env'] && typeof r['env'] === 'object' && !Array.isArray(r['env']) ? (r['env'] as Raw) : {}
  const env = Object.fromEntries(Object.entries(envRaw).map(([k, v]) => [k, String(v)]))
  const config: McpCandidate['config'] = url && !command ? { type: 'http', url } : { type: 'stdio', command: command!, args, ...(Object.keys(env).length ? { env } : {}) }
  return { name: name ?? deriveName(command, args, url), config, ...(notes.length ? { notes } : {}) }
}

const isServerLike = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v) && ('command' in v || 'url' in v || 'serverUrl' in v || 'httpUrl' in v)

function fromJson(text: string): { candidates: McpCandidate[]; error?: string } {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (e) {
    // a fragment copied from a README: `"name": { ... }` without the outer braces
    try {
      obj = JSON.parse(`{${text.replace(/,\s*$/, '')}}`)
    } catch {
      return { candidates: [], error: `not valid JSON: ${(e as Error).message}` }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { candidates: [], error: 'expected a JSON object' }
  const o = obj as Raw
  const nested = (o['mcpServers'] ?? o['servers'] ?? (o['mcp'] as Raw | undefined)?.['servers']) as unknown
  let map: Record<string, unknown> | undefined
  let single: Raw | undefined
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) map = nested as Record<string, unknown>
  else if (isServerLike(o)) single = o
  else if (Object.keys(o).length && Object.values(o).every(isServerLike)) map = o
  if (single) {
    const c = fromRaw(undefined, single)
    return typeof c === 'string' ? { candidates: [], error: c } : { candidates: [c] }
  }
  if (!map) return { candidates: [], error: 'no server found: expected "mcpServers", a server with "command" or "url", or a map of those' }
  const candidates: McpCandidate[] = []
  const errors: string[] = []
  for (const [name, row] of Object.entries(map)) {
    const c = isServerLike(row) ? fromRaw(cleanName(name), row) : 'not a server (needs "command" or "url")'
    if (typeof c === 'string') errors.push(`${name}: ${c}`)
    else candidates.push(c)
  }
  return candidates.length ? { candidates, ...(errors.length ? { error: errors.join('; ') } : {}) } : { candidates, error: errors.join('; ') || 'no server found' }
}

/** `claude mcp add [--transport http] [-e KEY=VAL] name -- command args` or `... name url`. */
function fromClaudeAdd(tokens: string[]): { candidates: McpCandidate[]; error?: string } {
  let i = 3
  let transport = ''
  const env: Record<string, string> = {}
  const positional: string[] = []
  let rest: string[] = []
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--') {
      rest = tokens.slice(i + 1)
      break
    }
    if (t === '--transport' || t === '-t') transport = tokens[++i] ?? ''
    else if (t === '--env' || t === '-e') {
      const [k, ...v] = (tokens[++i] ?? '').split('=')
      if (k) env[k] = v.join('=')
    } else if (t === '--scope' || t === '-s' || t === '--header' || t === '-H') i++
    else if (t.startsWith('-')) {
      /* an unknown flag: ignored */
    } else positional.push(t)
    i++
  }
  const name = positional[0]
  if (transport === 'http' || transport === 'sse' || (positional[1] && /^https?:\/\//i.test(positional[1]))) {
    const url = positional[1]
    if (!url) return { candidates: [], error: 'the url is missing' }
    const c = fromRaw(name, { url, type: transport })
    return typeof c === 'string' ? { candidates: [], error: c } : { candidates: [c] }
  }
  const cmd = rest.length ? rest : positional.slice(1)
  if (!cmd.length) return { candidates: [], error: 'the command is missing (after "--")' }
  const c = fromRaw(name, { command: cmd[0], args: cmd.slice(1), env })
  return typeof c === 'string' ? { candidates: [], error: c } : { candidates: [c] }
}

/**
 * Understands what people paste to add an MCP server: the JSON of Claude Desktop / Cursor / VS Code (one server or several),
 * a command line (`npx -y @scope/server-x C:\\folder`), `claude mcp add ...`, or a plain URL. It only READS the text:
 * nothing is started or saved here, the user sees every command before it is added.
 */
export function parseSnippet(input: string): { candidates: McpCandidate[]; error?: string } {
  const text = input.trim()
  if (!text) return { candidates: [], error: 'nothing to read: paste a configuration, a command or a url' }
  if (text.startsWith('{') || text.startsWith('"') || text.startsWith('[')) return fromJson(text)
  if (/^https?:\/\/\S+$/i.test(text)) {
    const c = fromRaw(undefined, { url: text })
    return typeof c === 'string' ? { candidates: [], error: c } : { candidates: [c] }
  }
  const tokens = splitCommandLine(text)
  if (tokens[0] === 'claude' && tokens[1] === 'mcp' && tokens[2] === 'add') return fromClaudeAdd(tokens)
  if (!tokens.length) return { candidates: [], error: 'nothing to read' }
  const c = fromRaw(undefined, { command: tokens[0], args: tokens.slice(1) })
  return typeof c === 'string' ? { candidates: [], error: c } : { candidates: [c] }
}
