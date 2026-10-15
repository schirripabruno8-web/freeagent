import type { ParseOutcome, ToolCall } from '@contracts/agent'

// The site's own tool runtime answers instead of us: "Tool read does not exist".
const NATIVE_FAIL =
  /\b(?:tool|function)\s+["'`]?[\w.:-]+["'`]?\s+(?:does\s*n[o']t\s+exist|is\s+not\s+(?:defined|available)|not\s+found)/i

/** JSON.parse that also forgives what models actually emit: raw newlines/tabs inside strings and trailing commas. */
export function lenientParse(src: string): unknown {
  try {
    return JSON.parse(src)
  } catch {
    /* fall through to repair */
  }
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      else if (ch === '\n') { out += '\\n'; continue }
      else if (ch === '\r') { out += '\\r'; continue }
      else if (ch === '\t') { out += '\\t'; continue }
      out += ch
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === ',' && /^\s*[}\]]/.test(src.slice(i + 1))) continue // trailing comma, outside strings only
    out += ch
  }
  return JSON.parse(out)
}

// `lax` accepts the shapes native tool markup uses ({name, arguments}); fenced plain JSON must say "tool".
function toCall(v: unknown, lax: boolean): { tool: string; args: unknown } | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'block is not a JSON object'
  const o = v as Record<string, unknown>
  const tool = o.tool ?? (lax ? o.name : undefined)
  if (typeof tool !== 'string' || !tool) return 'missing string field "tool"'
  let args: unknown = o.args ?? (lax ? (o.arguments ?? o.parameters) : undefined)
  if (args === undefined) {
    // Models often put the arguments next to "tool" instead of inside "args".
    const { tool: _t, name: _n, ...rest } = o
    args = rest
  }
  if (lax && typeof args === 'string') {
    try {
      args = lenientParse(args)
    } catch {
      return '"arguments" is a string that is not valid JSON'
    }
  }
  return { tool, args }
}

interface Hit {
  pos: number
  call?: { tool: string; args: unknown }
  error?: string
}

/**
 * Reads one assistant reply. `final: false` while streaming (an open block is "incomplete"),
 * `final: true` once the reply is finished (an open block is an error).
 */
export function parseReply(text: string, opts: { final: boolean }): ParseOutcome {
  const hits: Hit[] = []
  let open = false
  const prose: string[] = []

  // 1) <tool_call>{...}</tool_call> markup some sites/models use natively
  let rest = text.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_m, body: string, pos: number) => {
    try {
      const r = toCall(lenientParse(body.trim()), true)
      hits.push(typeof r === 'string' ? { pos, error: r } : { pos, call: r })
    } catch (e) {
      hits.push({ pos, error: `invalid JSON in <tool_call>: ${(e as Error).message}` })
    }
    return ''
  })
  if (rest.includes('<tool_call>')) {
    open = true
    rest = rest.slice(0, rest.indexOf('<tool_call>'))
  }

  // 2) fenced blocks
  type Fence = { ticks: number; info: string; body: string[]; pos: number }
  let fence: Fence | null = null
  let offset = 0
  const asProse = (f: Fence, closed: boolean): void => {
    prose.push('```' + f.info, ...f.body, ...(closed ? ['```'] : []))
  }
  const finishBlock = (f: Fence, closed: boolean): void => {
    const content = f.body.join('\n').trim()
    const isTool = f.info === 'tool'
    const looksLikeCall = isTool || (content.startsWith('{') && /"tool"\s*:/.test(content))
    if (!looksLikeCall) return asProse(f, closed)
    if (!closed) {
      open = true
      return
    }
    try {
      const r = toCall(lenientParse(content), isTool)
      hits.push(typeof r === 'string' ? { pos: f.pos, error: r } : { pos: f.pos, call: r })
    } catch (e) {
      hits.push({ pos: f.pos, error: `invalid JSON: ${(e as Error).message}` })
    }
  }
  for (const line of rest.split('\n')) {
    const start = offset
    offset += line.length + 1
    if (!fence) {
      const m = /^\s{0,3}(`{3,})\s*([\w+.-]*)/.exec(line)
      if (m) fence = { ticks: m[1]!.length, info: m[2]!.toLowerCase(), body: [], pos: start }
      else prose.push(line)
    } else if (new RegExp('^\\s{0,3}`{' + fence.ticks + ',}\\s*$').test(line)) {
      finishBlock(fence, true)
      fence = null
    } else fence.body.push(line)
  }
  if (fence) finishBlock(fence, false)

  const clean = prose.join('\n').trim()
  const errors = hits.flatMap((h) => (h.error ? [h.error] : []))
  if (open) {
    return opts.final
      ? { kind: 'invalid', text: clean, errors: [...errors, 'command block never closed (reply cut off?)'] }
      : { kind: 'incomplete', text: clean }
  }
  if (errors.length) return { kind: 'invalid', text: clean, errors }
  if (hits.length) {
    const calls: ToolCall[] = hits
      .sort((a, b) => a.pos - b.pos)
      .map((h, i) => ({ id: `c${i + 1}`, tool: h.call!.tool, args: h.call!.args }))
    return { kind: 'calls', calls, text: clean }
  }
  if (NATIVE_FAIL.test(text.slice(0, 200))) return { kind: 'native_tool_failure', text: clean }
  return { kind: 'text', text: clean }
}
