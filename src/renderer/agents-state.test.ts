import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@contracts/agent'
import { reduceAgents, type AgentRow } from './agents-state'

const ag = (id: string, status: AgentRow['status']): AgentEvent => ({
  type: 'agent',
  id,
  name: id,
  provider: 'deepseek',
  status
})

describe('reduceAgents', () => {
  it('aggiorna la riga dello stesso id senza cambiare l\'ordine di comparsa', () => {
    let s: AgentRow[] = []
    s = reduceAgents(s, ag('main', 'running'))
    s = reduceAgents(s, ag('analyst-1', 'queued'))
    s = reduceAgents(s, ag('main', 'done'))
    expect(s.map((r) => [r.id, r.status])).toEqual([
      ['main', 'done'],
      ['analyst-1', 'queued']
    ])
  })

  it('ignora gli eventi che non sono agent e non muta lo stato in ingresso', () => {
    const s = reduceAgents([], ag('main', 'running'))
    expect(reduceAgents(s, { type: 'status', text: 'ok' })).toBe(s)
    const snapshot = structuredClone(s)
    reduceAgents(s, ag('analyst-1', 'running'))
    expect(s).toEqual(snapshot)
  })
})
