import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadSelectors } from '../src/main/providers/load-selectors'

describe('loadSelectors', () => {
  it('config/selectors/deepseek.json e valido', () => {
    const c = loadSelectors(fileURLToPath(new URL('../config/selectors/deepseek.json', import.meta.url)))
    expect(c).toMatchObject({
      provider: 'deepseek',
      url: 'https://chat.deepseek.com/',
      allowedHosts: ['chat.deepseek.com'],
      inputKind: 'textarea'
    })
  })

  it('file non valido: l errore nomina il file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selectors-'))
    const file = join(dir, 'bad.json')
    try {
      writeFileSync(file, JSON.stringify({ provider: '' }))
      expect(() => loadSelectors(file)).toThrow(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
