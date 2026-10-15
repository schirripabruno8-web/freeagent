import { glob, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDef } from '@contracts/agent'
import { relLabel } from './diff'

const MAX = 500
const SKIP = new Set(['.git', 'node_modules'])

const schema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional()
})

export const globTool: ToolDef<z.infer<typeof schema>> = {
  name: 'glob',
  description: 'List files matching a glob such as "src/**/*.ts" under path. Folders are not listed; .git and node_modules are skipped.',
  argsHint: '{"pattern": string, "path"?: string}',
  schema,
  risk: 'read',
  paths: (a) => [a.path ?? '.'],
  async run({ pattern, path: p = '.' }, ctx) {
    // Node's glob reads "\" as an escape, so Windows-style separators are turned into "/".
    const pat = pattern.replaceAll('\\', '/')
    if (path.isAbsolute(pat) || /^[a-z]:/i.test(pat) || pat.split('/').includes('..')) {
      throw new Error(`pattern must stay inside ${p}: no absolute paths or ".." (${pattern})`)
    }
    const base = ctx.resolve(p)
    const found: string[] = []
    for await (const rel of glob(pat, { cwd: base, exclude: (n) => SKIP.has(path.basename(n)) })) {
      if (rel.split(/[\\/]/).some((s) => SKIP.has(s))) continue
      const full = path.join(base, rel)
      let real: string
      try {
        real = ctx.resolve(full) // throws for dangling links and for links out of the workspace
      } catch {
        continue
      }
      // glob can walk through junctions, so a hit may lead out of base or be a folder
      const r = path.relative(base, real)
      if (r.split(path.sep)[0] === '..' || path.isAbsolute(r) || !(await stat(real)).isFile()) continue
      found.push(relLabel(ctx.cwd, full))
    }
    if (!found.length) return 'no matches'
    found.sort()
    return found.slice(0, MAX).join('\n') + (found.length > MAX ? `\n[${found.length - MAX} more not shown]` : '')
  }
}
