import { describe, expect, it } from 'vitest'
import type { AgentReport, ToolCall } from '@contracts/agent'
import { applyEvent, type LogItem } from './log'

const call: ToolCall = { id: 'c1', tool: 'read', args: { path: 'a.txt' } }
const report: AgentReport = { summary: 'fatto', steps: 2, reason: 'finish' }

describe('applyEvent', () => {
  it('user: la richiesta apre la run e chiude la risposta ancora in streaming', () => {
    let log = applyEvent([], { type: 'assistant', text: 'in corso', done: false })
    log = applyEvent(log, { type: 'user', text: 'allunga il caricatore', resume: true, images: 1 })
    expect(log).toEqual([
      { kind: 'assistant', text: 'in corso', done: true },
      { kind: 'user', text: 'allunga il caricatore', resume: true, images: 1 }
    ])
  })

  it('sostituisce il messaggio assistant in streaming', () => {
    let log = applyEvent([], { type: 'assistant', text: 'Ci', done: false })
    log = applyEvent(log, { type: 'assistant', text: 'Ciao', done: false })
    expect(log).toEqual([{ kind: 'assistant', text: 'Ciao', done: false }])
  })

  it('done:true chiude il messaggio; il successivo ne apre uno nuovo', () => {
    let log = applyEvent([], { type: 'assistant', text: 'Ciao', done: true })
    log = applyEvent(log, { type: 'assistant', text: 'Altro', done: false })
    expect(log).toEqual([
      { kind: 'assistant', text: 'Ciao', done: true },
      { kind: 'assistant', text: 'Altro', done: false }
    ])
  })

  it('uno status a meta streaming non spezza il messaggio', () => {
    let log = applyEvent([], { type: 'assistant', text: 'Ci', done: false })
    log = applyEvent(log, { type: 'status', text: 'attendo' })
    log = applyEvent(log, { type: 'assistant', text: 'Ciao', done: true })
    expect(log).toEqual([
      { kind: 'assistant', text: 'Ciao', done: true },
      { kind: 'status', text: 'attendo' }
    ])
  })

  it('reminder non compare mai nel log', () => {
    const log = applyEvent([], { type: 'status', text: 'ok' })
    expect(applyEvent(log, { type: 'reminder', kind: 'periodic' })).toBe(log)
  })

  it('eventi agent non compaiono nel log', () => {
    const log = applyEvent([], { type: 'status', text: 'ok' })
    expect(applyEvent(log, { type: 'agent', id: 'main', name: 'main', provider: 'deepseek', status: 'running' })).toBe(log)
  })

  it('due sub-agenti in streaming insieme non si fondono con il principale', () => {
    let log = applyEvent([], { type: 'assistant', text: 'main', done: false })
    log = applyEvent(log, { type: 'assistant', text: 'a1', done: false, agent: 'analyst-1' })
    log = applyEvent(log, { type: 'assistant', text: 'b1', done: false, agent: 'analyst-2' })
    log = applyEvent(log, { type: 'assistant', text: 'a2', done: true, agent: 'analyst-1' })
    log = applyEvent(log, { type: 'assistant', text: 'main2', done: true })
    expect(log).toEqual([
      { kind: 'assistant', text: 'main2', done: true },
      { kind: 'assistant', text: 'a2', done: true, agent: 'analyst-1' },
      { kind: 'assistant', text: 'b1', done: false, agent: 'analyst-2' }
    ])
  })

  it('un evento di un sub-agente non chiude lo streaming del principale', () => {
    let log = applyEvent([], { type: 'assistant', text: 'Ci', done: false })
    log = applyEvent(log, { type: 'tool_call', call, agent: 'analyst-1' })
    log = applyEvent(log, { type: 'assistant', text: 'Ciao', done: true })
    expect(log).toEqual([
      { kind: 'assistant', text: 'Ciao', done: true },
      { kind: 'tool_call', call, agent: 'analyst-1' }
    ])
  })

  it('tool_result si attacca alla chiamata dello stesso agente, anche se l\'id e\' uguale', () => {
    let log = applyEvent([], { type: 'tool_call', call })
    log = applyEvent(log, { type: 'tool_call', call, agent: 'analyst-1' })
    log = applyEvent(log, { type: 'tool_result', id: 'c1', ok: true, output: 'ok', agent: 'analyst-1' })
    expect(log).toEqual([
      { kind: 'tool_call', call },
      { kind: 'tool_call', call, agent: 'analyst-1', result: { ok: true, output: 'ok' } }
    ])
  })

  it('tool_result si attacca alla sua tool_call via id', () => {
    let log = applyEvent([], { type: 'tool_call', call })
    log = applyEvent(log, { type: 'tool_result', id: 'c1', ok: true, output: 'ciao' })
    expect(log).toEqual([{ kind: 'tool_call', call, result: { ok: true, output: 'ciao' } }])
  })

  it('tool_result senza chiamata non viene perso', () => {
    expect(applyEvent([], { type: 'tool_result', id: 'x', ok: false, output: 'boom' })).toEqual([
      { kind: 'tool_result', id: 'x', ok: false, output: 'boom' }
    ])
  })

  it('error e finished chiudono lo streaming in corso e aggiungono il proprio item', () => {
    let log = applyEvent([], { type: 'assistant', text: 'parz', done: false })
    log = applyEvent(log, { type: 'error', kind: 'rate_limit', message: 'limite' })
    expect(log).toEqual([
      { kind: 'assistant', text: 'parz', done: true },
      { kind: 'error', text: '[rate_limit] limite' }
    ])
    expect(applyEvent(log, { type: 'finished', report })).toEqual([...log, { kind: 'finished', report }])
  })

  it('non muta il log in ingresso', () => {
    const input: LogItem[] = [
      { kind: 'assistant', text: 'a', done: false },
      { kind: 'tool_call', call }
    ]
    const snapshot = structuredClone(input)
    const out = applyEvent(input, { type: 'tool_result', id: 'c1', ok: true, output: 'x' })
    applyEvent(input, { type: 'assistant', text: 'b', done: true })
    expect(input).toEqual(snapshot)
    expect(out).not.toBe(input)
  })
})
