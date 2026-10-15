export type TextBlock = { kind: 'text'; text: string } | { kind: 'code'; lang: string; text: string; open: boolean }

/**
 * Splits a reply into prose and fenced code blocks. A fence still open (the reply is streaming) is a code block with `open: true`,
 * so a half-written command never shows up as raw backticks.
 */
export function splitBlocks(text: string): TextBlock[] {
  const out: TextBlock[] = []
  const re = /^```([\w+.#-]*)[ \t]*\r?\n?/gm
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const lang = m[1] ?? ''
    const start = m.index + m[0].length
    const close = /^```[ \t]*$/m.exec(text.slice(start))
    const prose = text.slice(pos, m.index)
    if (prose.trim()) out.push({ kind: 'text', text: prose.trim() })
    if (close) {
      out.push({ kind: 'code', lang, text: text.slice(start, start + close.index).replace(/\n$/, ''), open: false })
      pos = start + close.index + close[0].length
    } else {
      out.push({ kind: 'code', lang, text: text.slice(start), open: true })
      pos = text.length
    }
    re.lastIndex = pos
  }
  const rest = text.slice(pos)
  if (rest.trim()) out.push({ kind: 'text', text: rest.trim() })
  return out
}

/** One line that tells what a tool call does: the first useful argument, cut. */
export function argPreview(args: unknown, max = 70): string {
  if (!args || typeof args !== 'object') return ''
  const o = args as Record<string, unknown>
  const pick = ['path', 'command', 'pattern', 'agent', 'server', 'tool', 'name', 'task', 'summary'].find((k) => typeof o[k] === 'string')
  const v = pick ? String(o[pick]) : ((Object.values(o).find((x) => typeof x === 'string') as string | undefined) ?? '')
  const one = v.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
