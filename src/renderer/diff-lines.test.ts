import { describe, expect, it } from 'vitest'
import { classifyDiffLines } from './diff-lines'

const kinds = (text: string) => classifyDiffLines(text).map((l) => l.kind)

describe('classifyDiffLines', () => {
  it('classifica add, del, hunk, meta e ctx', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 1111..2222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' uguale',
      '-vecchia',
      '+nuova'
    ].join('\n')
    expect(classifyDiffLines(diff)).toEqual([
      { kind: 'meta', text: 'diff --git a/a.txt b/a.txt' },
      { kind: 'meta', text: 'index 1111..2222 100644' },
      { kind: 'meta', text: '--- a/a.txt' },
      { kind: 'meta', text: '+++ b/a.txt' },
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: ' uguale' },
      { kind: 'del', text: '-vecchia' },
      { kind: 'add', text: '+nuova' }
    ])
  })

  it('riga vuota di contesto resta ctx con testo vuoto', () => {
    expect(classifyDiffLines('@@ -1 +1 @@\n\n+x')).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'ctx', text: '' },
      { kind: 'add', text: '+x' }
    ])
  })

  it('"\\ No newline at end of file" non e\' contenuto: meta', () => {
    expect(kinds('-a\n\\ No newline at end of file\n+a')).toEqual(['del', 'meta', 'add'])
  })

  it('CRLF e newline finale non producono righe extra', () => {
    expect(classifyDiffLines('+a\r\n-b\r\n')).toEqual([
      { kind: 'add', text: '+a' },
      { kind: 'del', text: '-b' }
    ])
  })

  it('diff vuoto: nessuna riga', () => {
    expect(classifyDiffLines('')).toEqual([])
  })
})
