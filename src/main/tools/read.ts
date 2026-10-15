import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDef } from '@contracts/agent'

const MAX_CHARS = 100_000
const MAX_LINE = 2000

const schema = z.object({
  path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional()
})
type Args = z.infer<typeof schema>

export const readTool: ToolDef<Args> = {
  name: 'read',
  description: 'Read lines of a text file from a 1-based offset (default 2000 lines). Output has no line numbers.',
  argsHint: '{"path": string, "offset"?: int, "limit"?: int}',
  schema,
  risk: 'read',
  paths: (a) => [a.path],
  async run({ path: p, offset = 1, limit = 2000 }, ctx) {
    const abs = ctx.resolve(p)
    const st = await stat(abs)
    if (st.isDirectory()) throw new Error(`${p} is a directory: use glob`)
    // shortcut: files up to 50 MB are read whole into memory, upgrade: stream lines if bigger files must be readable
    if (st.size > 50 * 1024 * 1024) throw new Error('file is over 50 MB: read a slice with bash')
    const buf = await readFile(abs)
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`binary file (${buf.length} bytes), not shown`)
    const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop() // the newline that ends the last line is not a line of its own
    const start = offset - 1
    if (start >= lines.length) throw new Error(`offset ${offset} is past the end (${lines.length} lines)`)

    const out: string[] = []
    let size = 0
    for (const l of lines.slice(start, start + limit)) {
      const piece = l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)} [line cut]` : l
      size += piece.length + 1
      if (size > MAX_CHARS) break
      out.push(piece)
    }
    const end = start + out.length
    const body = out.join('\n')
    return end < lines.length ? `${body}\n[... showing lines ${offset}-${end} of ${lines.length}; use offset/limit]` : body
  }
}
