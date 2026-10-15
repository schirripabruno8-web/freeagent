import type { AgentEvent, AgentReport, ToolCall } from '@contracts/agent'

type LogBody =
  /** What the user asked (a run starts): `resume` = a follow-up in the same chat. */
  | { kind: 'user'; text: string; resume?: boolean; images?: number }
  | { kind: 'assistant'; text: string; done: boolean }
  | { kind: 'tool_call'; call: ToolCall; result?: { ok: boolean; output: string } }
  /** Result whose call is not in the log: kept, never dropped. */
  | { kind: 'tool_result'; id: string; ok: boolean; output: string }
  | { kind: 'status'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'finished'; report: AgentReport }

/** `agent` = the sub-agent that produced it (absent = the main agent). */
export type LogItem = LogBody & { agent?: string }

/** Pure: returns a new array and never mutates `log`. */
export function applyEvent(log: LogItem[], e: AgentEvent): LogItem[] {
  // The agents panel shows 'agent' events (agents-state.ts), not the log.
  if (e.type === 'reminder' || e.type === 'agent') return log

  // Streaming and tool matching are per agent: sub-agents can stream at the same time, and call ids can repeat across agents.
  const mine = (x: LogItem) => x.agent === e.agent

  if (e.type === 'assistant') {
    const item: LogItem = { kind: 'assistant', text: e.text, done: e.done, agent: e.agent }
    const i = log.findLastIndex((x) => x.kind === 'assistant' && !x.done && mine(x))
    return i < 0 ? [...log, item] : log.with(i, item)
  }

  if (e.type === 'status') return [...log, { kind: 'status', text: e.text, agent: e.agent }]

  // Any other event ends that agent's message still streaming. Status does not: it can arrive mid-stream.
  const closed: LogItem[] = log.map((x) => (x.kind === 'assistant' && !x.done && mine(x) ? { ...x, done: true } : x))

  switch (e.type) {
    case 'user':
      return [...closed, { kind: 'user', text: e.text, resume: e.resume, images: e.images }]
    case 'tool_call':
      return [...closed, { kind: 'tool_call', call: e.call, agent: e.agent }]
    case 'tool_result': {
      const i = closed.findLastIndex((x) => x.kind === 'tool_call' && mine(x) && x.call.id === e.id)
      const hit = closed[i]
      if (hit?.kind !== 'tool_call')
        return [...closed, { kind: 'tool_result', id: e.id, ok: e.ok, output: e.output, agent: e.agent }]
      return closed.with(i, { ...hit, result: { ok: e.ok, output: e.output } })
    }
    case 'error':
      return [...closed, { kind: 'error', text: `[${e.kind}] ${e.message}`, agent: e.agent }]
    case 'finished':
      return [...closed, { kind: 'finished', report: e.report, agent: e.agent }]
  }
}
