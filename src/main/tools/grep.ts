import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { z } from 'zod'
import type { ToolDef } from '@contracts/agent'
import { relLabel } from './diff'

const SKIP = new Set(['.git', 'node_modules'])
const MAX_BYTES = 2 * 1024 * 1024
// A catastrophic regex would freeze the Electron main process, so it runs in its own context with a time limit.
const RUN = 'const re = new RegExp(pattern, flags); lines.flatMap((l, i) => (re.test(l) ? [i] : []))'

const schema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignore_case: z.boolean().optional(),
  regex: z.boolean().optional(),
  max_results: z.number().int().min(1).max(500).optional()
})

/** Files under dir. Links and junctions are not followed: they may point outside the workspace or loop back. */
async function* walk(dir: string): AsyncGenerator<string> {
  // an unreadable folder is skipped, the search goes on
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (SKIP.has(d.name) || d.isSymbolicLink()) continue
    const full = path.join(dir, d.name)
    if (d.isDirectory()) yield* walk(full)
    else if (d.isFile()) yield full
  }
}

export const grepTool: ToolDef<z.infer<typeof schema>> = {
  name: 'grep',
  description:
    'Search file contents: literal text by default, regex with regex:true. Output "path:line: text". Skips binary files, files over 2 MB, .git, node_modules and links.',
  argsHint: '{"pattern": string, "path"?: string, "glob"?: string, "ignore_case"?: boolean, "regex"?: boolean, "max_results"?: int}',
  schema,
  risk: 'read',
  paths: (a) => [a.path ?? '.'],
  async run({ pattern, path: p = '.', glob, ignore_case = false, regex = false, max_results = 100 }, ctx) {
    const flags = ignore_case ? 'i' : ''
    if (regex) {
      try {
        new RegExp(pattern, flags)
      } catch (e) {
        throw new Error(`invalid regex: ${(e as Error).message}`)
      }
    }
    const top = ctx.resolve(p)
    const files = (await stat(top)).isFile() ? [top] : walk(top)
    const out: string[] = []
    let hits = 0
    let slow = 0
    let note = ''
    scan: for await (const f of files) {
      if (glob && !path.matchesGlob(path.basename(f), glob)) continue
      let buf: Buffer
      try {
        if ((await stat(f)).size > MAX_BYTES) continue
        buf = await readFile(f)
      } catch {
        continue // gone or locked between listing and reading: skip it
      }
      if (buf.subarray(0, 8000).includes(0)) continue
      const lines = buf.toString('utf8').split(/\r?\n/)
      const label = relLabel(ctx.cwd, f)
      let idx: number[]
      if (regex) {
        try {
          idx = runInNewContext(RUN, { lines, pattern, flags }, { timeout: 2000 })
        } catch (e) {
          if ((e as { code?: string }).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e
          out.push(`[skipped ${label}: pattern too slow]`)
          if (++slow === 3) {
            note = '[stopped: pattern too slow on 3 files]'
            break scan
          }
          continue
        }
      } else {
        const needle = ignore_case ? pattern.toLowerCase() : pattern
        idx = lines.flatMap((l, i) => ((ignore_case ? l.toLowerCase() : l).includes(needle) ? [i] : []))
      }
      for (const i of idx) {
        if (hits === max_results) {
          note = `[stopped at ${max_results} matches; raise max_results or narrow the search]`
          break scan
        }
        hits++
        out.push(`${label}:${i + 1}: ${lines[i]!.slice(0, 300)}`)
      }
    }
    if (!out.length) return 'no matches'
    return out.join('\n') + (note ? `\n${note}` : '')
  }
}
