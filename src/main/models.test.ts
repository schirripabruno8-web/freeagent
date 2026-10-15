import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadModels } from './models'

let dir: string
beforeEach(() => void (dir = mkdtempSync(path.join(tmpdir(), 'fa-models-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('loadModels', () => {
  it('config/models.json e\' valido e ogni provider ha almeno la voce "default"', () => {
    const { models, skipped } = loadModels(fileURLToPath(new URL('../../config/models.json', import.meta.url)))
    expect(skipped).toBe(0)
    const providers = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../config/providers.json', import.meta.url)), 'utf8')
    ) as { id: string }[]
    for (const p of providers) expect(models.some((m) => m.provider === p.id && m.id === 'default'), p.id).toBe(true)
  })

  it('una riga sbagliata viene saltata, le altre restano; i default dello schema si applicano', () => {
    const f = path.join(dir, 'm.json')
    writeFileSync(f, JSON.stringify([{ provider: 'a', id: 'x', label: 'X' }, { provider: '', id: 'y', label: 'Y' }, 5]))
    const r = loadModels(f)
    expect(r.skipped).toBe(2)
    expect(r.models).toEqual([{ provider: 'a', id: 'x', label: 'X', capabilities: [], toolReliability: 'unknown' }])
  })

  it('file illeggibile o non-array: errore chiaro', () => {
    const f = path.join(dir, 'm.json')
    writeFileSync(f, '{"a":1}')
    expect(() => loadModels(f)).toThrow(/must be a JSON array/)
    expect(() => loadModels(path.join(dir, 'nope.json'))).toThrow(/cannot read/)
  })
})
