import { describe, expect, it } from 'vitest'
import { makeDiff } from './diff'

describe('makeDiff', () => {
  it('vuoto se non cambia nulla', () => {
    expect(makeDiff('a.txt', 'x\n', 'x\n')).toBe('')
  })

  it('solo --- e +++ con a/ e b/, niente Index: ne ====', () => {
    const out = makeDiff('src/a.ts', 'one\n', 'two\n')
    expect(out.startsWith('--- a/src/a.ts\n+++ b/src/a.ts\n@@')).toBe(true)
    expect(out).not.toMatch(/^Index:|^====/m)
  })

  it('contesto di 3 righe per lato', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i + 1}`)
    const changed = lines.map((l, i) => (i === 4 ? 'X' : l))
    expect(makeDiff('f.txt', lines.join('\n') + '\n', changed.join('\n') + '\n')).toContain('@@ -2,7 +2,7 @@')
  })

  it('file nuovo: diff contro il vuoto', () => {
    expect(makeDiff('n.txt', '', 'a\nb\n')).toContain('@@ -0,0 +1,2 @@')
  })

  it('oltre 20000 caratteri viene tagliato con nota', () => {
    const out = makeDiff('big.txt', '', 'x'.repeat(30000) + '\n')
    expect(out.length).toBeLessThan(20100)
    expect(out.endsWith('\n[diff truncated]')).toBe(true)
  })
})
