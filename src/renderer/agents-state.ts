import type { AgentEvent } from '@contracts/agent'

export type AgentRow = Omit<Extract<AgentEvent, { type: 'agent' }>, 'type' | 'agent'>

/** Pure: one row per agent id, in first-seen order; the latest event for an id wins. Never mutates `state`. */
export function reduceAgents(state: AgentRow[], e: AgentEvent): AgentRow[] {
  if (e.type !== 'agent') return state
  const row: AgentRow = { id: e.id, name: e.name, provider: e.provider, status: e.status, note: e.note }
  const i = state.findIndex((r) => r.id === e.id)
  return i < 0 ? [...state, row] : state.with(i, row)
}
