import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@contracts/agent'
import { chatUrlOf, compact, HistoryStore, Recorder, type RunRecord } from './history'

const dirs: string[] = []
const store = (max?: number) => {
  const d = mkdtempSync(join(tmpdir(), 'fa-history-'))
  dirs.push(d)
  return { d, s: new HistoryStore(d, max) }
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  provider: 'qwen',
  cwd: 'D:/pistol',
  task: 'Ricrea la pistola',
  status: 'done',
  summary: 'fatto',
  startedAt: 1000,
  events: [{ type: 'user', text: 'Ricrea la pistola' }, { type: 'assistant', text: 'ok', done: true }],
  ...over
})

describe('HistoryStore', () => {
  it('registra una chat e la rilegge: lista (piu recente prima) ed eventi', () => {
    const { s } = store()
    const a = s.record(run({ task: 'prima' }))
    const b = s.record(run({ task: 'seconda', chatUrl: 'https://chat.qwen.ai/c/2' }))
    expect(s.list().map((m) => m.title)).toEqual(['seconda', 'prima'])
    expect(s.load(a.id)?.events).toHaveLength(2)
    expect(s.load(b.id)?.meta).toMatchObject({ provider: 'qwen', cwd: 'D:/pistol', chatUrl: 'https://chat.qwen.ai/c/2', runs: 1 })
  })

  it('una run che finisce nella STESSA chat (provider + pagina) si aggiunge alla voce: titolo e inizio restano, runs sale', () => {
    const { s } = store()
    const first = s.record(run({ task: 'Ricrea la pistola', chatUrl: 'https://chat.qwen.ai/c/1', startedAt: 1000 }))
    const second = s.record(
      run({ task: 'allunga il caricatore', chatUrl: 'https://chat.qwen.ai/c/1', status: 'error', summary: 'errore', startedAt: 5000, events: [{ type: 'user', text: 'allunga il caricatore', resume: true }] })
    )
    expect(second.id).toBe(first.id)
    expect(s.list()).toHaveLength(1)
    expect(second).toMatchObject({ title: 'Ricrea la pistola', startedAt: 1000, runs: 2, status: 'error', summary: 'errore' })
    expect(s.load(first.id)?.events.map((e) => e.type)).toEqual(['user', 'assistant', 'user'])
    // another provider with the same URL is a different chat
    expect(s.record(run({ provider: 'deepseek', chatUrl: 'https://chat.qwen.ai/c/1' })).id).not.toBe(first.id)
  })

  it('tiene al massimo `max` chat e cancella i file delle piu vecchie', () => {
    const { d, s } = store(2)
    const ids = [1, 2, 3].map((n) => s.record(run({ task: `t${n}`, chatUrl: `https://chat.qwen.ai/c/${n}` })).id)
    expect(s.list()).toHaveLength(2)
    expect(existsSync(join(d, `${ids[0]}.json`))).toBe(false)
    expect(existsSync(join(d, `${ids[2]}.json`))).toBe(true)
  })

  it('remove toglie voce e file; id non validi (percorsi) vengono ignorati senza toccare il disco', () => {
    const { d, s } = store()
    const m = s.record(run())
    writeFileSync(join(d, 'fuori.json'), '[]')
    s.remove('../fuori')
    s.remove('..\\fuori')
    expect(existsSync(join(d, 'fuori.json'))).toBe(true)
    expect(s.load('../index')).toBeUndefined()
    s.remove(m.id)
    expect(s.list()).toEqual([])
    expect(existsSync(join(d, `${m.id}.json`))).toBe(false)
  })

  it('indice rovinato o file eventi rovinato: niente eccezioni, la cronologia riparte pulita', () => {
    const { d, s } = store()
    const m = s.record(run())
    writeFileSync(join(d, `${m.id}.json`), '{non json')
    expect(s.load(m.id)).toMatchObject({ meta: { id: m.id }, events: [] })
    writeFileSync(join(d, 'index.json'), '[{"id":"x"}]')
    expect(s.list()).toEqual([])
    writeFileSync(join(d, 'index.json'), 'rotto')
    expect(s.list()).toEqual([])
    expect(() => s.record(run())).not.toThrow()
    expect(JSON.parse(readFileSync(join(d, 'index.json'), 'utf8'))).toHaveLength(1)
  })

  it('al massimo 3000 eventi per chat (restano gli ultimi)', () => {
    const { s } = store()
    const many: AgentEvent[] = Array.from({ length: 3200 }, (_, i) => ({ type: 'status', text: `s${i}` }))
    const m = s.record(run({ events: many }))
    const ev = s.load(m.id)!.events
    expect(ev).toHaveLength(3000)
    expect(ev.at(-1)).toEqual({ type: 'status', text: 's3199' })
  })
})

describe('Recorder e compact', () => {
  it('le istantanee di una risposta in corso si sostituiscono, per agente; reminder e agent non si tengono', () => {
    const r = new Recorder()
    r.push({ type: 'assistant', text: 'a', done: false })
    r.push({ type: 'assistant', text: 'a b', done: false, agent: 'modeler-1' })
    r.push({ type: 'assistant', text: 'a b c', done: false })
    r.push({ type: 'reminder', kind: 'format' })
    r.push({ type: 'agent', id: 'main', name: 'main', provider: 'qwen', status: 'running' })
    r.push({ type: 'assistant', text: 'a b c d', done: true })
    expect(r.events).toEqual([
      { type: 'assistant', text: 'a b c d', done: true }, // the final version replaces the last snapshot: one entry per reply
      { type: 'assistant', text: 'a b', done: false, agent: 'modeler-1' }
    ])
    r.push({ type: 'assistant', text: 'seconda risposta', done: true })
    expect(r.events).toHaveLength(3)
  })

  it('testi e argomenti molto lunghi vengono tagliati, il resto no', () => {
    const big = 'x'.repeat(20_000)
    expect((compact({ type: 'assistant', text: big, done: true }) as { text: string }).text.length).toBeLessThan(12_200)
    expect((compact({ type: 'tool_result', id: '1', ok: true, output: big }) as { output: string }).output.length).toBeLessThan(12_200)
    const c = compact({ type: 'tool_call', call: { id: '1', tool: 'write', args: { path: 'a.txt', content: big } } })
    const args = (c as { call: { args: { path: string; content: string } } }).call.args
    expect(args.path).toBe('a.txt')
    expect(args.content.length).toBeLessThan(4_200)
    const s: AgentEvent = { type: 'status', text: 'ok' }
    expect(compact(s)).toBe(s)
  })
})

describe('chatUrlOf', () => {
  const home = 'https://chat.qwen.ai/'
  it('una pagina di chat si, la home e la chat transitoria no, altro sito no', () => {
    expect(chatUrlOf('https://chat.qwen.ai/c/abc-123', home)).toBe('https://chat.qwen.ai/c/abc-123')
    expect(chatUrlOf('https://chat.qwen.ai/', home)).toBeUndefined()
    expect(chatUrlOf('https://chat.qwen.ai/c/new-chat', home)).toBeUndefined()
    expect(chatUrlOf('https://evil.example/c/abc', home)).toBeUndefined()
    expect(chatUrlOf('http://chat.qwen.ai/c/abc', home)).toBeUndefined()
    expect(chatUrlOf('non un url', home)).toBeUndefined()
  })
})
