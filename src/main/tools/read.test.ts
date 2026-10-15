import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ToolContext } from '@contracts/agent'
import { createSandbox } from '../sandbox'
import { readTool } from './read'

const win = process.platform === 'win32'
let base: string
let ws: string

const ctx = (): ToolContext => {
  const sb = createSandbox(ws)
  return { cwd: sb.resolve('.', false), resolve: (p) => sb.resolve(p, false), checkpoint: async () => {} }
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-read-')))
  ws = path.join(base, 'work')
  mkdirSync(path.join(ws, 'sub'), { recursive: true })
  writeFileSync(path.join(ws, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(path.join(ws, 'bom.txt'), '﻿x\r\ny\r\n')
  writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0x41, 0, 0x42]))
  writeFileSync(path.join(ws, 'long.txt'), 'x'.repeat(2500))
  writeFileSync(path.join(ws, 'big.txt'), Array.from({ length: 200 }, () => 'y'.repeat(1000)).join('\n'))
  writeFileSync(path.join(ws, 'empty.txt'), '')
  writeFileSync(path.join(ws, 'huge.bin'), '')
  truncateSync(path.join(ws, 'huge.bin'), 50 * 1024 * 1024 + 1) // refused by size, before anything is read
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('read', () => {
  it('returns the lines without line numbers', async () => {
    await expect(readTool.run({ path: 'a.txt' }, ctx())).resolves.toBe('one\ntwo\nthree')
  })

  it('offset and limit, with a note when the file goes on', async () => {
    await expect(readTool.run({ path: 'a.txt', offset: 2, limit: 1 }, ctx())).resolves.toBe(
      'two\n[... showing lines 2-2 of 3; use offset/limit]'
    )
  })

  it('strips the BOM and returns CRLF as LF', async () => {
    await expect(readTool.run({ path: 'bom.txt' }, ctx())).resolves.toBe('x\ny')
  })

  it('refuses a folder and points at glob', async () => {
    await expect(readTool.run({ path: 'sub' }, ctx())).rejects.toThrow('is a directory: use glob')
  })

  it('refuses files over 50 MB before reading them', async () => {
    await expect(readTool.run({ path: 'huge.bin' }, ctx())).rejects.toThrow(
      'file is over 50 MB: read a slice with bash'
    )
  })

  it('refuses binary files (NUL in the first 8000 bytes)', async () => {
    await expect(readTool.run({ path: 'bin.dat' }, ctx())).rejects.toThrow('binary file (3 bytes), not shown')
  })

  it('cuts a line over 2000 characters', async () => {
    await expect(readTool.run({ path: 'long.txt' }, ctx())).resolves.toBe('x'.repeat(2000) + ' [line cut]')
  })

  it('stops at 100000 characters and says where it stopped', async () => {
    const r = await readTool.run({ path: 'big.txt' }, ctx())
    expect(r.endsWith('[... showing lines 1-99 of 200; use offset/limit]')).toBe(true)
  })

  it('an offset past the end is an error', async () => {
    await expect(readTool.run({ path: 'a.txt', offset: 9 }, ctx())).rejects.toThrow('past the end (3 lines)')
  })

  it('schema: offset >= 1, limit 1..5000', () => {
    expect(readTool.schema.safeParse({ path: 'a', offset: 0 }).success).toBe(false)
    expect(readTool.schema.safeParse({ path: 'a', limit: 5001 }).success).toBe(false)
    expect(readTool.schema.safeParse({ path: 'a', limit: 5000 }).success).toBe(true)
  })

  it('declares the path it touches', () => {
    expect(readTool.paths?.({ path: 'a.txt' })).toEqual(['a.txt'])
  })

  it('refuses paths outside the workspace', async () => {
    await expect(readTool.run({ path: '../x' }, ctx())).rejects.toThrow('outside the workspace')
  })

  it.skipIf(!win)('refuses reserved names and alternate data streams', async () => {
    await expect(readTool.run({ path: 'CON' }, ctx())).rejects.toThrow('reserved device name')
    await expect(readTool.run({ path: 'a.txt:s' }, ctx())).rejects.toThrow('path refused')
  })

  it('an empty file has nothing to show from line 1', async () => {
    await expect(readTool.run({ path: 'empty.txt' }, ctx())).rejects.toThrow('past the end (0 lines)')
  })
})
