import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ToolContext, ToolDef } from '@contracts/agent'
import { makeDiff, relLabel } from './diff'

const schema = z.object({
  path: z.string(),
  content: z.string().refine((s) => Buffer.byteLength(s) <= 5 * 1024 * 1024, 'content is over 5 MB')
})
type Args = z.infer<typeof schema>

function plan(args: Args, ctx: ToolContext) {
  const abs = ctx.resolve(args.path)
  const label = relLabel(ctx.cwd, abs)
  let old: string | undefined
  if (existsSync(abs)) {
    const st = statSync(abs)
    if (st.isDirectory()) throw new Error(`${label} is a directory`)
    if (st.size > 10 * 1024 * 1024) throw new Error(`${label} already exists and is over 10 MB: refusing to overwrite it blindly`)
    old = readFileSync(abs, 'utf8')
  }
  return { abs, label, old }
}

export const writeTool: ToolDef<Args> = {
  name: 'write',
  description: 'Create a file, or overwrite it whole, with the given content. Missing parent folders are created.',
  argsHint: '{"path": string, "content": string}',
  schema,
  risk: 'write',
  paths: (a) => [a.path],
  async preview(args, ctx) {
    const { label, old } = plan(args, ctx)
    return makeDiff(label, old ?? '', args.content)
  },
  async run(args, ctx) {
    const { abs, label, old } = plan(args, ctx)
    await ctx.checkpoint([abs])
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, args.content, 'utf8')
    const head = `${old === undefined ? 'created' : 'overwrote'} ${label} (${Buffer.byteLength(args.content)} bytes)`
    return `${head}\n${makeDiff(label, old ?? '', args.content)}`.trimEnd()
  }
}
