import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointStore, pruneRuns } from './checkpoint'

let base: string
let store: CheckpointStore
const f = (n: string) => path.join(base, 'work', n)
const read = (n: string) => readFileSync(f(n), 'utf8')

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'fa-ckpt-'))
  mkdirSync(path.join(base, 'work'))
  store = new CheckpointStore(path.join(base, 'ckpt'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('CheckpointStore', () => {
  it('ripristina un file modificato e cancella uno che non esisteva', async () => {
    writeFileSync(f('a.txt'), 'v1')
    const id = await store.create('edit', [f('a.txt'), f('nuevo.txt')])
    writeFileSync(f('a.txt'), 'v2')
    writeFileSync(f('nuevo.txt'), 'creado')
    const r = await store.restoreTo(id)
    expect(read('a.txt')).toBe('v1')
    expect(existsSync(f('nuevo.txt'))).toBe(false)
    expect(r.restored.sort()).toEqual([f('a.txt'), f('nuevo.txt')].sort())
  })

  it('restoreTo riavvolge TUTTO dal piu recente a quello scelto, e li dimentica', async () => {
    writeFileSync(f('a.txt'), 'v1')
    const c1 = await store.create('edit', [f('a.txt')])
    writeFileSync(f('a.txt'), 'v2')
    const c2 = await store.create('edit', [f('a.txt')])
    writeFileSync(f('a.txt'), 'v3')
    await store.restoreTo(c2)
    expect(read('a.txt')).toBe('v2')
    expect((await store.list()).map((c) => c.id)).toEqual([c1])
    writeFileSync(f('a.txt'), 'v9')
    await store.restoreTo(c1)
    expect(read('a.txt')).toBe('v1')
    expect(await store.list()).toEqual([])
  })

  it('byte esatti: binario e CRLF non si alterano', async () => {
    const bin = Buffer.from([0, 255, 13, 10, 1, 2, 0])
    writeFileSync(f('b.bin'), bin)
    const id = await store.create('write', [f('b.bin')])
    writeFileSync(f('b.bin'), 'otra cosa')
    await store.restoreTo(id)
    expect(readFileSync(f('b.bin')).equals(bin)).toBe(true)
  })

  it('ricrea le cartelle cancellate al ripristino', async () => {
    mkdirSync(f('d'))
    writeFileSync(f('d/x.txt'), 'x')
    const id = await store.create('write', [f('d/x.txt')])
    rmSync(f('d'), { recursive: true })
    await store.restoreTo(id)
    expect(read('d/x.txt')).toBe('x')
  })

  it('list: ordine, metadati, e gli id continuano a crescere con una seconda istanza', async () => {
    writeFileSync(f('a.txt'), '1')
    const a = await store.create('edit', [f('a.txt')])
    const b = await new CheckpointStore(path.join(base, 'ckpt')).create('write', [f('a.txt')])
    expect(b > a).toBe(true)
    const l = await store.list()
    expect(l.map((c) => c.tool)).toEqual(['edit', 'write'])
    expect(l[0]!.files).toEqual([f('a.txt')])
  })

  it('rifiuta cio che non si puo annullare: cartelle e id sconosciuto', async () => {
    await expect(store.create('write', [path.join(base, 'work')])).rejects.toThrow(/not a regular file/)
    await expect(store.restoreTo('000099')).rejects.toThrow(/unknown checkpoint/)
  })

  it('un checkpoint a meta (senza manifest) viene ignorato', async () => {
    mkdirSync(path.join(base, 'ckpt', '000001'), { recursive: true })
    expect(await store.list()).toEqual([])
  })
})

describe('pruneRuns', () => {
  it('cancella solo le cartelle vecchie', async () => {
    const old = path.join(base, 'runs', 'old')
    const fresh = path.join(base, 'runs', 'fresh')
    mkdirSync(old, { recursive: true })
    mkdirSync(fresh)
    const past = new Date(Date.now() - 10 * 24 * 3600 * 1000)
    utimesSync(old, past, past)
    await pruneRuns(path.join(base, 'runs'), 7 * 24 * 3600 * 1000)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})
