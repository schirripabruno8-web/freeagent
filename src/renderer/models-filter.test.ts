import { describe, expect, it } from 'vitest'
import type { ModelEntry } from '@contracts/models'
import { filterModels } from './models-filter'

const m = (id: string, o: Partial<ModelEntry> = {}): ModelEntry => ({
  provider: 'deepseek',
  id,
  label: id,
  capabilities: [],
  toolReliability: 'unknown',
  ...o
})

const f = { provider: 'deepseek', query: '', onlyReliable: false }
const ids = (list: ModelEntry[]) => list.map((x) => x.id)

describe('filterModels', () => {
  it('tiene solo il provider scelto', () => {
    expect(ids(filterModels([m('a'), m('b', { provider: 'qwen' })], f))).toEqual(['a'])
  })

  it('cerca in label, id, notes e capabilities: senza maiuscole e spazi ai bordi', () => {
    const models = [
      m('alfa', { label: 'Alfa Max' }),
      m('beta', { notes: 'Usa il RAGIONAMENTO lungo' }),
      m('gamma', { capabilities: ['long-context'] }),
      m('delta')
    ]
    expect(ids(filterModels(models, { ...f, query: '  alfa MAX ' }))).toEqual(['alfa'])
    expect(ids(filterModels(models, { ...f, query: 'ragionamento' }))).toEqual(['beta'])
    expect(ids(filterModels(models, { ...f, query: 'long-context' }))).toEqual(['gamma'])
    expect(ids(filterModels(models, { ...f, query: 'delta' }))).toEqual(['delta'])
  })

  it('onlyReliable tiene solo i good', () => {
    const models = [m('a', { toolReliability: 'fair' }), m('b', { toolReliability: 'good' })]
    expect(ids(filterModels(models, { ...f, onlyReliable: true }))).toEqual(['b'])
  })

  it('ordina good, fair, unknown, poor; a parita resta l\'ordine del registro', () => {
    const models = [
      m('p1', { toolReliability: 'poor' }),
      m('u1'),
      m('f1', { toolReliability: 'fair' }),
      m('g1', { toolReliability: 'good' }),
      m('u2'),
      m('g2', { toolReliability: 'good' })
    ]
    expect(ids(filterModels(models, f))).toEqual(['g1', 'g2', 'f1', 'u1', 'u2', 'p1'])
  })

  it('non muta il registro in ingresso', () => {
    const models = [m('p', { toolReliability: 'poor' }), m('g', { toolReliability: 'good' })]
    filterModels(models, f)
    expect(ids(models)).toEqual(['p', 'g'])
  })
})
