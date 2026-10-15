import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import type { ToolContext, ToolDef } from '@contracts/agent'
import { makeDiff, relLabel } from './diff'

const schema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional()
})
type Args = z.infer<typeof schema>
const MAX_TEXT = 10 * 1024 * 1024

/** Checks and computes the edit without writing. preview and run share it, so they fail the same way. */
function plan(args: Args, ctx: ToolContext) {
  if (args.old_string === '') throw new Error('old_string is empty')
  if (args.old_string === args.new_string) throw new Error('no change: old_string and new_string are identical')
  const abs = ctx.resolve(args.path)
  const label = relLabel(ctx.cwd, abs)
  if (!existsSync(abs)) throw new Error('file not found: use write to create it')
  const st = statSync(abs)
  if (st.isDirectory()) throw new Error(`${label} is a directory`)
  if (st.size > MAX_TEXT) throw new Error(`${label} is over 10 MB: too large to edit`)
  const before = readFileSync(abs, 'utf8')
  // Decoding then re-encoding would silently corrupt a binary or non-UTF-8 file.
  if (before.includes('\0') || before.includes('�')) throw new Error(`${label} is not a UTF-8 text file: cannot edit it safely`)
  // The BOM is not text: keep it out of the match, put it back on write.
  const bom = before.startsWith('﻿') ? '﻿' : ''
  const body = before.slice(bom.length)
  // Windows files are CRLF and the model writes LF: convert its strings so they match and the file stays CRLF.
  // shortcut: a file that mixes LF and CRLF only matches CRLF-converted text, upgrade: match line endings per line if such files appear.
  const crlf = body.includes('\r\n')
  const eol = (s: string) => (crlf && !s.includes('\r\n') ? s.replace(/\n/g, '\r\n') : s)
  const from = eol(args.old_string)
  const to = eol(args.new_string)
  const n = body.split(from).length - 1
  if (n === 0) throw new Error('old_string not found (exact, whitespace-sensitive)')
  if (n > 1 && !args.replace_all) throw new Error(`old_string matches ${n} places: add surrounding context or set replace_all`)
  // split/join, not String.replace: a "$&" in new_string must stay literal.
  return { abs, label, before, after: bom + body.split(from).join(to), n }
}

export const editTool: ToolDef<Args> = {
  name: 'edit',
  description: 'Replace exact text in an existing file. old_string must match once unless replace_all is true.',
  argsHint: '{"path": string, "old_string": string, "new_string": string, "replace_all"?: boolean}',
  schema,
  risk: 'write',
  paths: (a) => [a.path],
  async preview(args, ctx) {
    const p = plan(args, ctx)
    return makeDiff(p.label, p.before, p.after)
  },
  async run(args, ctx) {
    const p = plan(args, ctx)
    await ctx.checkpoint([p.abs])
    writeFileSync(p.abs, p.after, 'utf8')
    const head = `edited ${p.label} (${p.n} replacement${p.n === 1 ? '' : 's'})`
    return `${head}\n${makeDiff(p.label, p.before, p.after)}`.trimEnd()
  }
}
