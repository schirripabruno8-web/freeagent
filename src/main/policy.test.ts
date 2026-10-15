import { describe, expect, it } from 'vitest'
import type { RiskLevel } from '@contracts/agent'
import type { PermissionMode } from '@contracts/permissions'
import { decide } from './policy'

const v = (m: PermissionMode, r: RiskLevel, outside = false, allow = false) => decide(m, r, outside, allow).verdict

describe('decide: matrice dei permessi', () => {
  it('read: libero dentro, chiede fuori, in tutti i modi', () => {
    for (const m of ['readonly', 'ask', 'auto'] as const) {
      expect(v(m, 'read')).toBe('allow')
      expect(v(m, 'read', true)).toBe('ask')
    }
  })

  it('write: readonly nega (anche fuori), ask chiede, auto lascia passare solo dentro', () => {
    expect(v('readonly', 'write')).toBe('deny')
    expect(v('readonly', 'write', true)).toBe('deny')
    expect(v('ask', 'write')).toBe('ask')
    expect(v('ask', 'write', true)).toBe('ask')
    expect(v('auto', 'write')).toBe('allow')
    expect(v('auto', 'write', true)).toBe('ask')
  })

  it('bash: chiede sempre salvo allowlist; readonly lo nega anche in allowlist', () => {
    expect(v('ask', 'exec')).toBe('ask')
    expect(v('auto', 'exec')).toBe('ask')
    expect(v('ask', 'exec', false, true)).toBe('allow')
    expect(v('auto', 'exec', false, true)).toBe('allow')
    expect(v('readonly', 'exec')).toBe('deny')
    expect(v('readonly', 'exec', false, true)).toBe('deny')
  })

  it('full: file e bash passano da soli, ma fuori dalla cartella chiede ancora e readonly resta negato', () => {
    expect(v('full', 'write')).toBe('allow')
    expect(v('full', 'exec')).toBe('allow')
    expect(v('full', 'write', true)).toBe('ask')
    expect(v('full', 'read', true)).toBe('ask')
    expect(v('full', 'read')).toBe('allow')
    expect(v('readonly', 'exec', false, true)).toBe('deny')
  })

  it('il motivo del rifiuto viene spiegato al modello', () => {
    const d = decide('readonly', 'write', false, false)
    expect(d.verdict === 'deny' && d.reason).toMatch(/read-only/)
  })
})
