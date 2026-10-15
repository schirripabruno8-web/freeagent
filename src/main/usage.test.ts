import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderAdapter } from '@contracts/provider'
import { counted, Usage } from './usage'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fa-usage-'))
  file = path.join(dir, 'usage.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const at = (iso: string) => () => new Date(iso)

describe('Usage', () => {
  it('conta oggi e gli ultimi 7 giorni per provider, e persiste', () => {
    const u = new Usage(file, at('2026-10-12T10:00:00'))
    u.record('deepseek')
    u.record('deepseek')
    u.record('qwen')
    expect(u.summary()).toEqual({ deepseek: { today: 2, week: 2 }, qwen: { today: 1, week: 1 } })
    expect(new Usage(file, at('2026-10-12T23:00:00')).summary().deepseek).toEqual({ today: 2, week: 2 })
  })

  it('i giorni passati contano nella settimana ma non in oggi; oltre 7 giorni no; oltre 14 vengono potati', () => {
    writeFileSync(
      file,
      JSON.stringify({ deepseek: { '2026-10-12': 1, '2026-10-08': 4, '2026-10-02': 9, '2026-09-01': 5 } })
    )
    const u = new Usage(file, at('2026-10-12T10:00:00'))
    expect(u.summary().deepseek).toEqual({ today: 1, week: 5 })
    u.record('deepseek')
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).deepseek)).not.toContain('2026-09-01')
  })

  it('un file rotto parte da zero; un file non scrivibile non rompe nulla', () => {
    writeFileSync(file, '{broken')
    expect(new Usage(file).summary()).toEqual({})
    expect(() => new Usage(path.join(dir, 'no', 'such', 'dir', 'u.json')).record('x')).not.toThrow()
  })
})

describe('counted', () => {
  it('conta solo i messaggi inviati con successo', async () => {
    let n = 0
    let fail = false
    const base = {
      id: 'x',
      send: async () => {
        if (fail) throw new Error('boom')
      }
    } as unknown as ProviderAdapter
    const a = counted(base, () => n++)
    await a.send('uno')
    await a.send('due')
    fail = true
    await expect(a.send('tre')).rejects.toThrow('boom')
    expect(n).toBe(2)
  })
})
