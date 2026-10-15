import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@contracts/agent'
import { createSandbox } from '../sandbox'
import { editTool } from './edit'

const win = process.platform === 'win32'
let base: string
let ws: string
let ctx: ToolContext
// Content of each file at the moment checkpoint was called (null = did not exist).
let seen: Array<string | null>
const file = (p: string) => path.join(ws, p)

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-edit-')))
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

describe('edit', () => {
  it('sostituzione unica: checkpoint prima della scrittura, poi riporta il diff', async () => {
    writeFileSync(file('a.ts'), 'const a = 1\nconst b = 2\n')
    const out = await editTool.run({ path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 9' }, ctx)
    expect(seen).toEqual(['const a = 1\nconst b = 2\n'])
    expect(readFileSync(file('a.ts'), 'utf8')).toBe('const a = 9\nconst b = 2\n')
    expect(out.startsWith('edited a.ts (1 replacement)\n')).toBe(true)
    expect(out).toContain('-const a = 1')
    expect(out).toContain('+const a = 9')
  })

  it('replace_all sostituisce tutte le occorrenze', async () => {
    writeFileSync(file('a.txt'), 'x-x-x')
    const out = await editTool.run({ path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx)
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('y-y-y')
    expect(out.startsWith('edited a.txt (3 replacements)\n')).toBe(true)
  })

  it('piu\' occorrenze senza replace_all: errore e nessuna modifica', async () => {
    writeFileSync(file('a.txt'), 'x x')
    await expect(editTool.run({ path: 'a.txt', old_string: 'x', new_string: 'y' }, ctx)).rejects.toThrow(
      'old_string matches 2 places: add surrounding context or set replace_all'
    )
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('x x')
    expect(ctx.checkpoint).not.toHaveBeenCalled()
  })

  it('old_string non trovata: errore e nessuna modifica', async () => {
    writeFileSync(file('a.txt'), 'abc')
    await expect(editTool.run({ path: 'a.txt', old_string: 'ABC', new_string: 'x' }, ctx)).rejects.toThrow(
      'old_string not found (exact, whitespace-sensitive)'
    )
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('abc')
  })

  it('nessun cambiamento, old_string vuota, file mancante, cartella: errori chiari', async () => {
    writeFileSync(file('a.txt'), 'abc')
    mkdirSync(file('d'))
    await expect(editTool.run({ path: 'a.txt', old_string: 'a', new_string: 'a' }, ctx)).rejects.toThrow(/no change/)
    await expect(editTool.run({ path: 'a.txt', old_string: '', new_string: 'x' }, ctx)).rejects.toThrow('old_string is empty')
    await expect(editTool.run({ path: 'nope.txt', old_string: 'a', new_string: 'b' }, ctx)).rejects.toThrow(
      'file not found: use write to create it'
    )
    await expect(editTool.run({ path: 'd', old_string: 'a', new_string: 'b' }, ctx)).rejects.toThrow(/is a directory/)
    expect(ctx.checkpoint).not.toHaveBeenCalled()
  })

  it('file CRLF con old_string in LF: il file resta CRLF', async () => {
    writeFileSync(file('w.txt'), 'a\r\nb\r\nc\r\n')
    await editTool.run({ path: 'w.txt', old_string: 'a\nb\n', new_string: 'X\nY\nZ\n' }, ctx)
    expect(readFileSync(file('w.txt')).equals(Buffer.from('X\r\nY\r\nZ\r\nc\r\n'))).toBe(true)
  })

  it('file CRLF con old_string gia\' in CRLF: nessuna doppia conversione', async () => {
    writeFileSync(file('w.txt'), 'a\r\nb\r\n')
    await editTool.run({ path: 'w.txt', old_string: 'a\r\nb', new_string: 'c\r\nd' }, ctx)
    expect(readFileSync(file('w.txt')).equals(Buffer.from('c\r\nd\r\n'))).toBe(true)
  })

  it('BOM iniziale preservato', async () => {
    writeFileSync(file('b.txt'), Buffer.from('﻿hello world'))
    await editTool.run({ path: 'b.txt', old_string: 'hello', new_string: 'bye' }, ctx)
    expect(readFileSync(file('b.txt')).equals(Buffer.from('﻿bye world'))).toBe(true)
  })

  it('"$&" in new_string resta letterale', async () => {
    writeFileSync(file('a.txt'), 'a')
    await editTool.run({ path: 'a.txt', old_string: 'a', new_string: 'x$&y' }, ctx)
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('x$&y')
  })

  it('se il checkpoint lancia il file resta intatto', async () => {
    writeFileSync(file('a.txt'), 'old')
    ctx.checkpoint = vi.fn(async () => {
      throw new Error('snapshot failed')
    })
    await expect(editTool.run({ path: 'a.txt', old_string: 'old', new_string: 'new' }, ctx)).rejects.toThrow('snapshot failed')
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('old')
  })

  it('preview calcola il diff senza scrivere', async () => {
    writeFileSync(file('a.txt'), 'one\ntwo\n')
    const diff = await editTool.preview!({ path: 'a.txt', old_string: 'two', new_string: 'three' }, ctx)
    expect(diff).toContain('-two')
    expect(diff).toContain('+three')
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(ctx.checkpoint).not.toHaveBeenCalled()
  })

  it('preview lancia lo stesso errore di run', async () => {
    writeFileSync(file('a.txt'), 'abc')
    await expect(editTool.preview!({ path: 'a.txt', old_string: 'zzz', new_string: 'q' }, ctx)).rejects.toThrow(
      'old_string not found'
    )
  })

  it('percorso fuori dalla cartella: lancia e non tocca nulla', async () => {
    writeFileSync(path.join(base, 'x.txt'), 'keep')
    await expect(editTool.run({ path: '../x.txt', old_string: 'keep', new_string: 'gone' }, ctx)).rejects.toThrow(
      /outside the workspace/
    )
    expect(readFileSync(path.join(base, 'x.txt'), 'utf8')).toBe('keep')
  })

  it.skipIf(!win)('nomi vietati su Windows: lancia e non scrive', async () => {
    writeFileSync(file('a.txt'), 'abc')
    for (const p of ['a.txt:s', 'CON']) {
      await expect(editTool.run({ path: p, old_string: 'abc', new_string: 'x' }, ctx)).rejects.toThrow(/path refused/)
    }
    expect(readdirSync(ws)).toEqual(['a.txt'])
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('abc')
  })

  it('dichiara il percorso per il controllo permessi', () => {
    expect(editTool.paths?.({ path: 'a/b.txt', old_string: 'x', new_string: 'y' })).toEqual(['a/b.txt'])
  })
})

describe('edit: file che non si possono modificare in sicurezza', () => {
  it('un binario (NUL) o un non-UTF-8 viene rifiutato e resta intatto', async () => {
    const bin = Buffer.from([0x61, 0x00, 0x62])
    writeFileSync(file('b.bin'), bin)
    await expect(editTool.run({ path: 'b.bin', old_string: 'a', new_string: 'z' }, ctx)).rejects.toThrow(/not a UTF-8 text file/)
    expect(readFileSync(file('b.bin')).equals(bin)).toBe(true)
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]) // "cafe" with a Latin-1 e-acute: invalid UTF-8
    writeFileSync(file('l.txt'), latin1)
    await expect(editTool.run({ path: 'l.txt', old_string: 'caf', new_string: 'x' }, ctx)).rejects.toThrow(/not a UTF-8 text file/)
    expect(readFileSync(file('l.txt')).equals(latin1)).toBe(true)
    expect(ctx.checkpoint).not.toHaveBeenCalled()
  })

  it('oltre 10 MB: rifiutato', async () => {
    writeFileSync(file('big.txt'), 'x'.repeat(10 * 1024 * 1024 + 1))
    await expect(editTool.run({ path: 'big.txt', old_string: 'x', new_string: 'y' }, ctx)).rejects.toThrow(/over 10 MB/)
  })
})
