import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSandbox } from './sandbox'

const win = process.platform === 'win32'
let base: string
let ws: string
let outside: string
const sb = () => createSandbox(ws)
const inside = (p: string) => {
  const c = sb().classify(p)
  return c.ok && c.inside
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-sandbox-')))
  ws = path.join(base, 'work')
  outside = path.join(base, 'secret')
  mkdirSync(path.join(ws, 'sub'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(ws, 'a.txt'), 'a')
  writeFileSync(path.join(outside, 'k.txt'), 'k')
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('createSandbox: dentro e fuori', () => {
  it('relativi, assoluti e file non ancora esistenti dentro la cartella', () => {
    expect(inside('a.txt')).toBe(true)
    expect(inside('sub/new/deep/file.txt')).toBe(true)
    expect(inside(path.join(ws, 'a.txt'))).toBe(true)
    expect(inside('.')).toBe(true)
    expect(inside('')).toBe(true)
  })

  it('.. e percorsi assoluti altrove sono fuori', () => {
    expect(inside('../secret/k.txt')).toBe(false)
    expect(inside('sub/../../secret/k.txt')).toBe(false)
    expect(inside(path.join(outside, 'k.txt'))).toBe(false)
    expect(inside(win ? 'C:\\Windows\\System32' : '/etc/passwd')).toBe(false)
  })

  it('un fratello con lo stesso prefisso (work2) non e\' dentro work', () => {
    mkdirSync(path.join(base, 'work2'), { recursive: true })
    expect(inside('../work2/x.txt')).toBe(false)
  })

  it('resolve: lancia fuori dalla cartella solo se non e\' stato approvato', () => {
    const s = sb()
    expect(s.resolve('a.txt', false)).toBe(path.join(ws, 'a.txt'))
    expect(() => s.resolve('../secret/k.txt', false)).toThrow(/outside the workspace/)
    expect(s.resolve('../secret/k.txt', true)).toBe(path.join(outside, 'k.txt'))
  })

  it('una junction dentro la cartella che punta fuori NON e\' dentro (anche per file non esistenti)', () => {
    const link = path.join(ws, 'link')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return // no permission to create links on this machine
    }
    expect(inside('link/k.txt')).toBe(false)
    expect(inside('link/new.txt')).toBe(false)
    expect(() => sb().resolve('link/k.txt', false)).toThrow(/outside the workspace/)
  })

  it('un symlink-file dentro che punta fuori NON e\' dentro', () => {
    const link = path.join(ws, 'flink.txt')
    try {
      symlinkSync(path.join(outside, 'k.txt'), link, 'file')
    } catch {
      return // symlinks need privileges on Windows
    }
    expect(inside('flink.txt')).toBe(false)
  })

  it('un link che pende nel vuoto viene rifiutato, non seguito in silenzio', () => {
    const link = path.join(ws, 'dangling')
    try {
      symlinkSync(path.join(outside, 'does-not-exist'), link, 'junction')
    } catch {
      return
    }
    const c = sb().classify('dangling/x.txt')
    expect(c.ok && c.inside).toBe(false)
  })

  it('NUL nel percorso', () => {
    expect(sb().classify('a\0.txt').ok).toBe(false)
  })
})

describe.skipIf(!win)('createSandbox: regole di Windows', () => {
  const refused = (p: string) => expect(sb().classify(p).ok, p).toBe(false)

  it('maiuscole/minuscole e lettera di unita\'', () => {
    expect(inside(path.join(ws.toUpperCase(), 'a.txt'))).toBe(true)
    expect(inside(path.join(ws.toLowerCase(), 'a.txt'))).toBe(true)
  })

  it('flussi alternativi NTFS', () => {
    refused('a.txt:hidden')
    refused('a.txt::$DATA')
    refused('sub\\a.txt:x:$DATA')
  })

  it('nomi di dispositivo riservati, con o senza estensione, in qualsiasi segmento', () => {
    for (const p of ['CON', 'nul', 'aux.txt', 'sub/PRN', 'COM1', 'lpt9.log', 'sub\\nul.txt']) refused(p)
    expect(inside('console.txt')).toBe(true) // contains "con" but is not the device
  })

  it('prefissi \\\\?\\ e \\\\.\\', () => {
    refused('\\\\?\\C:\\Windows')
    refused('\\\\.\\pipe\\x')
    refused('//?/C:/Windows')
  })

  it('percorsi di rete UNC mai dentro', () => {
    const c = sb().classify('\\\\server\\share\\x.txt')
    expect(c.ok && c.inside).toBe(false)
  })

  it('punto o spazio finale (Windows li toglie: "a.txt." e\' "a.txt")', () => {
    refused('a.txt.')
    refused('a.txt ')
    refused('sub./f.txt')
    refused('sub /f.txt')
  })

  it('caratteri jolly e non validi', () => {
    for (const p of ['*.txt', 'a?.txt', 'a<b', 'a>b', 'a|b', 'a"b']) refused(p)
  })

  it('un altro disco e\' fuori o rifiutato, mai dentro', () => {
    const c = sb().classify('Z:\\nope\\x.txt')
    expect(c.ok && c.inside).toBe(false)
  })
})
