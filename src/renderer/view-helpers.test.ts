import { describe, expect, it } from 'vitest'
import type { HistoryMeta } from '@contracts/history'
import { groupByDay, matches, whenLabel } from './history-view'
import { argPreview, splitBlocks } from './text-blocks'

const DAY = 24 * 3600 * 1000
const now = new Date(2026, 9, 15, 15, 0, 0).getTime()
const meta = (id: string, ago: number, over: Partial<HistoryMeta> = {}): HistoryMeta => ({
  id,
  provider: 'qwen',
  cwd: 'D:/pistol',
  title: `chat ${id}`,
  startedAt: now - ago,
  updatedAt: now - ago,
  status: 'done',
  summary: 'fatto',
  runs: 1,
  ...over
})

describe('splitBlocks', () => {
  it('prosa e blocchi di codice in ordine, con il linguaggio', () => {
    const b = splitBlocks('Leggo il file.\n```tool\n{"tool":"read"}\n```\nPoi continuo.')
    expect(b).toEqual([
      { kind: 'text', text: 'Leggo il file.' },
      { kind: 'code', lang: 'tool', text: '{"tool":"read"}', open: false },
      { kind: 'text', text: 'Poi continuo.' }
    ])
  })

  it('un blocco ancora aperto (risposta in streaming) e un blocco aperto, mai backtick grezzi', () => {
    expect(splitBlocks('Ecco:\n```python\nprint(1)')).toEqual([
      { kind: 'text', text: 'Ecco:' },
      { kind: 'code', lang: 'python', text: 'print(1)', open: true }
    ])
  })

  it('piu blocchi, nessun blocco, testo vuoto', () => {
    expect(splitBlocks('```a\n1\n```\n```b\n2\n```').map((x) => x.kind === 'code' && x.text)).toEqual(['1', '2'])
    expect(splitBlocks('solo testo')).toEqual([{ kind: 'text', text: 'solo testo' }])
    expect(splitBlocks('')).toEqual([])
  })
})

describe('argPreview', () => {
  it('sceglie il primo argomento utile e lo accorcia', () => {
    expect(argPreview({ path: 'BRIEF.md' })).toBe('BRIEF.md')
    expect(argPreview({ command: 'ls   -la' })).toBe('ls -la')
    expect(argPreview({ agent: 'modeler', task: 'x'.repeat(200) })).toBe('modeler')
    expect(argPreview({ task: 'x'.repeat(200) }, 20)).toHaveLength(20)
    expect(argPreview(undefined)).toBe('')
    expect(argPreview({ n: 1, s: 'primo testo' })).toBe('primo testo')
  })
})

describe('groupByDay / whenLabel / matches', () => {
  it('raggruppa per giorno, piu recente prima, senza gruppi vuoti', () => {
    const g = groupByDay([meta('old', 20 * DAY), meta('a', 60_000), meta('y', DAY), meta('b', 3 * 3600_000), meta('w', 4 * DAY)], now)
    expect(g.map((x) => x.label)).toEqual(['Oggi', 'Ieri', 'Ultimi 7 giorni', 'Più vecchie'])
    expect(g[0]!.items.map((m) => m.id)).toEqual(['a', 'b'])
    expect(groupByDay([meta('a', 1000)], now).map((x) => x.label)).toEqual(['Oggi'])
    expect(groupByDay([], now)).toEqual([])
  })

  it('etichette del tempo', () => {
    expect(whenLabel(now - 10_000, now)).toBe('adesso')
    expect(whenLabel(now - 5 * 60_000, now)).toBe('5 min fa')
    expect(whenLabel(now - 3 * 3600_000, now)).toMatch(/^oggi \d\d:\d\d$/)
    expect(whenLabel(now - DAY, now)).toMatch(/^ieri /)
    expect(whenLabel(now - 9 * DAY, now)).toMatch(/\d/)
  })

  it('la ricerca guarda titolo, esito, cartella e provider', () => {
    const m = meta('a', 0, { title: 'Ricrea la pistola', summary: 'caricatore allungato', cwd: 'D:/pistol', provider: 'qwen' })
    expect(['pistola', 'ALLUNGATO', 'd:/pistol', 'qwen', '  '].every((q) => matches(m, q))).toBe(true)
    expect(matches(m, 'deepseek')).toBe(false)
  })
})
