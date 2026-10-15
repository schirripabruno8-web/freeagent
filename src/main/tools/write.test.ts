import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@contracts/agent'
import { createSandbox } from '../sandbox'
import { writeTool } from './write'

const win = process.platform === 'win32'
let base: string
let ws: string
let ctx: ToolContext
// Content of each file at the moment checkpoint was called (null = did not exist).
let seen: Array<string | null>
const file = (p: string) => path.join(ws, p)

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-write-')))
  ws = path.join(base, 'work')
  mkdirSync(ws)
  const sb = createSandbox(ws)
  seen = []
  ctx = {
    cwd: sb.resolve('.', false),
    resolve: (p: string) => sb.resolve(p, false),
    checkpoint: vi.fn(async (files: string[]) => {
      seen = files.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : null))
    })
  }
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('write', () => {
  it('file nuovo: crea le cartelle annidate e riporta created + diff', async () => {
    const out = await writeTool.run({ path: 'sub/deep/new.txt', content: 'hello\n' }, ctx)
    expect(readFileSync(file('sub/deep/new.txt'), 'utf8')).toBe('hello\n')
    expect(out.startsWith('created sub/deep/new.txt (6 bytes)\n--- a/sub/deep/new.txt\n+++ b/sub/deep/new.txt')).toBe(true)
    expect(out).toContain('+hello')
    expect(seen).toEqual([null])
    expect(ctx.checkpoint).toHaveBeenCalledWith([file('sub/deep/new.txt')])
  })

  it('sovrascrittura: checkpoint vede il vecchio contenuto, poi riporta overwrote', async () => {
    writeFileSync(file('a.txt'), 'old\n')
    const out = await writeTool.run({ path: 'a.txt', content: 'new\n' }, ctx)
    expect(seen).toEqual(['old\n'])
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('new\n')
    expect(out.startsWith('overwrote a.txt (4 bytes)\n')).toBe(true)
    expect(out).toContain('-old')
    expect(out).toContain('+new')
  })

  it('se il checkpoint lancia non scrive e non crea cartelle', async () => {
    writeFileSync(file('a.txt'), 'old')
    ctx.checkpoint = vi.fn(async () => {
      throw new Error('snapshot failed')
    })
    await expect(writeTool.run({ path: 'a.txt', content: 'new' }, ctx)).rejects.toThrow('snapshot failed')
    await expect(writeTool.run({ path: 'd/x.txt', content: 'x' }, ctx)).rejects.toThrow('snapshot failed')
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('old')
    expect(existsSync(file('d'))).toBe(false)
  })

  it('scrive il testo com\'e: niente conversione di fine riga, niente BOM', async () => {
    await writeTool.run({ path: 'w.txt', content: 'a\nb\r\n' }, ctx)
    expect(readFileSync(file('w.txt')).equals(Buffer.from('a\nb\r\n'))).toBe(true)
  })

  it('una cartella esistente e\' un errore', async () => {
    mkdirSync(file('sub'))
    await expect(writeTool.run({ path: 'sub', content: 'x' }, ctx)).rejects.toThrow(/is a directory/)
  })

  it('preview calcola il diff senza scrivere', async () => {
    writeFileSync(file('a.txt'), 'old\n')
    const diff = await writeTool.preview!({ path: 'a.txt', content: 'new\n' }, ctx)
    expect(diff).toContain('-old')
    expect(diff).toContain('+new')
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('old\n')
    expect(ctx.checkpoint).not.toHaveBeenCalled()
  })

  it('percorso fuori dalla cartella: lancia e non scrive', async () => {
    await expect(writeTool.run({ path: '../x.txt', content: 'x' }, ctx)).rejects.toThrow(/outside the workspace/)
    expect(existsSync(path.join(base, 'x.txt'))).toBe(false)
    expect(ctx.checkpoint).not.toHaveBeenCalled()
  })

  it.skipIf(!win)('nomi vietati su Windows: lancia e non scrive', async () => {
    for (const p of ['a.txt:s', 'CON']) {
      await expect(writeTool.run({ path: p, content: 'x' }, ctx)).rejects.toThrow(/path refused/)
    }
    expect(readdirSync(ws)).toEqual([])
  })

  it('content oltre 5 MB rifiutato dallo schema', () => {
    expect(writeTool.schema.safeParse({ path: 'a', content: 'x'.repeat(5 * 1024 * 1024 + 1) }).success).toBe(false)
    expect(writeTool.schema.safeParse({ path: 'a', content: 'x'.repeat(5 * 1024 * 1024) }).success).toBe(true)
  })

  it('dichiara il percorso per il controllo permessi', () => {
    expect(writeTool.paths?.({ path: 'a/b.txt', content: '' })).toEqual(['a/b.txt'])
  })
})
