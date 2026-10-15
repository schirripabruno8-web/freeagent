import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@contracts/agent'
import { createSandbox } from '../sandbox'
import { grepTool } from './grep'

// Simulated OS refusals: a locked file, a file that vanishes after listing, a folder that cannot be listed.
const fault = vi.hoisted(() => ({ read: new Set<string>(), stat: new Set<string>(), list: new Set<string>() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const fail = (code: string) => Promise.reject(Object.assign(new Error(`${code}: simulated`), { code }))
  return {
    ...real,
    readdir: (p: string, ...a: any[]) => (fault.list.has(p) ? fail('EPERM') : (real.readdir as any)(p, ...a)),
    readFile: (p: string, ...a: any[]) => (fault.read.has(p) ? fail('EACCES') : (real.readFile as any)(p, ...a)),
    stat: (p: string, ...a: any[]) => (fault.stat.has(p) ? fail('ENOENT') : (real.stat as any)(p, ...a))
  }
})

let base: string
let ws: string

const ctx = (): ToolContext => {
  const sb = createSandbox(ws)
  return { cwd: sb.resolve('.', false), resolve: (p) => sb.resolve(p, false), checkpoint: async () => {} }
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-grep-')))
  ws = path.join(base, 'work')
  const outside = path.join(base, 'outside')
  for (const d of ['src', 'node_modules', '.git', 'flaky/lockeddir', 'slow']) mkdirSync(path.join(ws, d), { recursive: true })
  mkdirSync(outside)
  const w = (rel: string, data: string | Buffer) => writeFileSync(path.join(ws, rel), data)
  w('src/a.ts', 'const hello = 1\nHELLO world\nnothing here\n')
  w('notes.md', 'hello markdown\n')
  w('node_modules/x.ts', 'hello\n')
  w('.git/config', 'hello\n')
  w('bin.dat', Buffer.from('hello\0hello'))
  w('big.txt', 'hello' + 'x'.repeat(2 * 1024 * 1024))
  w('longline.txt', 'hello' + 'y'.repeat(400))
  w('redos.txt', 'a'.repeat(44) + 'b\n')
  w('hits.txt', Array.from({ length: 150 }, () => 'hit').join('\n'))
  writeFileSync(path.join(outside, 'secret.txt'), 'hello outside\n')
  symlinkSync(outside, path.join(ws, 'jout'), 'junction')
  symlinkSync(ws, path.join(ws, 'src', 'jroot'), 'junction') // loops back to the workspace
  w('flaky/ok.txt', 'zork ok\n')
  w('flaky/locked.txt', 'zork locked\n')
  w('flaky/gone.txt', 'zork gone\n')
  w('flaky/lockeddir/inner.txt', 'zork inner\n')
  for (let i = 1; i <= 4; i++) w(`slow/r${i}.txt`, 'a'.repeat(44) + 'b\n')
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('grep', () => {
  it('literal, case-sensitive by default', async () => {
    await expect(grepTool.run({ pattern: 'hello', path: 'src' }, ctx())).resolves.toBe('src/a.ts:1: const hello = 1')
  })

  it('ignore_case', async () => {
    await expect(grepTool.run({ pattern: 'hello', path: 'src', ignore_case: true }, ctx())).resolves.toBe(
      'src/a.ts:1: const hello = 1\nsrc/a.ts:2: HELLO world'
    )
  })

  it('glob filters file names', async () => {
    await expect(grepTool.run({ pattern: 'hello', glob: '*.md' }, ctx())).resolves.toBe('notes.md:1: hello markdown')
  })

  it('a single file as path', async () => {
    await expect(grepTool.run({ pattern: 'hello', path: 'notes.md' }, ctx())).resolves.toBe('notes.md:1: hello markdown')
  })

  it('skips binary, files over 2 MB, .git, node_modules, and does not follow links', async () => {
    const r = await grepTool.run({ pattern: 'hello' }, ctx())
    const files = r.split('\n').map((l) => l.split(':')[0]).sort()
    expect(files).toEqual(['longline.txt', 'notes.md', 'src/a.ts'])
  })

  it('cuts the text at 300 characters', async () => {
    const r = await grepTool.run({ pattern: 'hello', path: 'longline.txt' }, ctx())
    expect(r.startsWith('longline.txt:1: hello')).toBe(true)
    expect(r.slice('longline.txt:1: '.length)).toHaveLength(300)
  })

  it('max_results: stops and says so only when there are more hits', async () => {
    const capped = await grepTool.run({ pattern: 'hit', path: 'hits.txt' }, ctx())
    expect(capped.split('\n')).toHaveLength(101)
    expect(capped.split('\n').at(-1)).toMatch(/^\[stopped at 100 matches/)
    const all = await grepTool.run({ pattern: 'hit', path: 'hits.txt', max_results: 150 }, ctx())
    expect(all.split('\n')).toHaveLength(150)
  })

  it('no matches', async () => {
    await expect(grepTool.run({ pattern: 'zzz' }, ctx())).resolves.toBe('no matches')
  })

  it('regex', async () => {
    await expect(
      grepTool.run({ pattern: 'hello\\s+world', regex: true, ignore_case: true, path: 'src' }, ctx())
    ).resolves.toBe('src/a.ts:2: HELLO world')
  })

  it('an invalid regex is an error', async () => {
    await expect(grepTool.run({ pattern: '(', regex: true }, ctx())).rejects.toThrow('invalid regex')
  })

  it('a catastrophic regex is cut off by the time limit and the file is skipped', async () => {
    const t0 = Date.now()
    await expect(grepTool.run({ pattern: '(a+)+$', regex: true, path: 'redos.txt' }, ctx())).resolves.toBe(
      '[skipped redos.txt: pattern too slow]'
    )
    expect(Date.now() - t0).toBeLessThan(3500)
  }, 10_000)

  it('an unreadable or vanished file or folder is skipped and the search goes on', async () => {
    fault.read.add(path.join(ws, 'flaky', 'locked.txt'))
    fault.stat.add(path.join(ws, 'flaky', 'gone.txt'))
    fault.list.add(path.join(ws, 'flaky', 'lockeddir'))
    try {
      await expect(grepTool.run({ pattern: 'zork', path: 'flaky' }, ctx())).resolves.toBe('flaky/ok.txt:1: zork ok')
    } finally {
      fault.read.clear()
      fault.stat.clear()
      fault.list.clear()
    }
  })

  it('regex: after 3 files time out the search stops and says so', async () => {
    const lines = (await grepTool.run({ pattern: '(a+)+$', regex: true, path: 'slow' }, ctx())).split('\n')
    expect(lines).toHaveLength(4)
    expect(lines.slice(0, 3).every((l) => /^\[skipped slow\/r\d\.txt: pattern too slow\]$/.test(l))).toBe(true)
    expect(lines[3]).toBe('[stopped: pattern too slow on 3 files]')
  }, 15_000)

  it('refuses a path outside the workspace', async () => {
    await expect(grepTool.run({ pattern: 'x', path: '../x' }, ctx())).rejects.toThrow('outside the workspace')
  })

  it('declares the path it touches', () => {
    expect(grepTool.paths?.({ pattern: 'x' })).toEqual(['.'])
  })
})
