import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ToolContext } from '@contracts/agent'
import { createSandbox } from '../sandbox'
import { globTool } from './glob'

let base: string
let ws: string
let lw: string
let outside: string

const ctxOf = (root: string): ToolContext => {
  const sb = createSandbox(root)
  return { cwd: sb.resolve('.', false), resolve: (p) => sb.resolve(p, false), checkpoint: async () => {} }
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-glob-')))
  ws = path.join(base, 'work')
  for (const d of ['sub/deep', 'sub/node_modules', 'node_modules', '.git', 'dirs.ts', 'many']) {
    mkdirSync(path.join(ws, d), { recursive: true })
  }
  for (const f of ['a.ts', 'sub/b.ts', 'sub/deep/c.md', 'node_modules/x.ts', 'sub/node_modules/y.ts', '.git/h.ts']) {
    writeFileSync(path.join(ws, f), f)
  }
  for (let i = 0; i <= 500; i++) writeFileSync(path.join(ws, 'many', `f${String(i).padStart(3, '0')}.txt`), '')

  lw = path.join(base, 'links')
  outside = path.join(base, 'outside')
  mkdirSync(path.join(lw, 'sub'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(lw, 'a.ts'), 'a')
  writeFileSync(path.join(outside, 'secret.ts'), 'k')
  symlinkSync(outside, path.join(lw, 'jout'), 'junction')
  symlinkSync(lw, path.join(lw, 'sub', 'jroot'), 'junction') // points at an ancestor: a loop
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('glob', () => {
  it('lists files only, sorted, relative with "/", skipping .git and node_modules', async () => {
    await expect(globTool.run({ pattern: '**/*.ts' }, ctxOf(ws))).resolves.toBe('a.ts\nsub/b.ts')
  })

  it('searches under path and reports paths from the workspace', async () => {
    await expect(globTool.run({ pattern: '*.ts', path: 'sub' }, ctxOf(ws))).resolves.toBe('sub/b.ts')
  })

  it('accepts Windows-style separators', async () => {
    await expect(globTool.run({ pattern: 'sub\\*.ts' }, ctxOf(ws))).resolves.toBe('sub/b.ts')
  })

  it('no matches', async () => {
    await expect(globTool.run({ pattern: '*.zzz' }, ctxOf(ws))).resolves.toBe('no matches')
  })

  it('lists at most 500 files and says how many were left out', async () => {
    const r = await globTool.run({ pattern: 'many/*.txt' }, ctxOf(ws))
    expect(r.split('\n')).toHaveLength(501)
    expect(r.endsWith('[1 more not shown]')).toBe(true)
  })

  it('refuses patterns that leave the folder', async () => {
    await expect(globTool.run({ pattern: '../*.ts' }, ctxOf(ws))).rejects.toThrow('no absolute paths or ".."')
    await expect(globTool.run({ pattern: path.join(base, '*.ts') }, ctxOf(ws))).rejects.toThrow('no absolute paths')
  })

  it('refuses a path outside the workspace', async () => {
    await expect(globTool.run({ pattern: '*', path: '../x' }, ctxOf(ws))).rejects.toThrow('outside the workspace')
  })

  it('declares the path it touches', () => {
    expect(globTool.paths?.({ pattern: '*' })).toEqual(['.'])
  })

  it('junctions: nothing outside the folder is listed, and a loop back to an ancestor ends', async () => {
    const r = await globTool.run({ pattern: '**/*' }, ctxOf(lw))
    expect(r).not.toContain('secret')
    expect(r).not.toContain('jout')
    expect(r).toContain('a.ts')
  })
})
