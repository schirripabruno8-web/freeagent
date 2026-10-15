import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadSettings, saveSettings } from './settings'

let dir: string
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
const file = () => path.join((dir = mkdtempSync(path.join(tmpdir(), 'fa-settings-'))), 'settings.json')

describe('settings', () => {
  it('senza file i valori sono quelli prudenti e nessun server MCP e spento', () => {
    expect(loadSettings(file())).toEqual({ mode: 'ask', ponytail: 'full', mcpDisabled: [] })
  })

  it('salva e rilegge la lista dei server MCP spenti', () => {
    const f = file()
    saveSettings(f, { mode: 'auto', ponytail: 'ultra', mcpDisabled: ['github', 'blender'] })
    expect(loadSettings(f)).toEqual({ mode: 'auto', ponytail: 'ultra', mcpDisabled: ['github', 'blender'] })
  })

  it('un valore sbagliato non azzera gli altri: la lista rovinata torna vuota, il resto resta', () => {
    const f = file()
    writeFileSync(f, JSON.stringify({ mode: 'full', ponytail: 'lite', mcpDisabled: 'blender' }))
    expect(loadSettings(f)).toEqual({ mode: 'full', ponytail: 'lite', mcpDisabled: [] })
    writeFileSync(f, JSON.stringify({ mode: 'full', mcpDisabled: ['a', 3] }))
    expect(loadSettings(f)).toMatchObject({ mode: 'full', mcpDisabled: [] })
    writeFileSync(f, 'non json')
    expect(loadSettings(f)).toEqual({ mode: 'ask', ponytail: 'full', mcpDisabled: [] })
  })
})
