import { describe, expect, it } from 'vitest'
import { lenientParse, parseReply } from './parser'

const fin = (t: string) => parseReply(t, { final: true })
const T = '```'

describe('parseReply', () => {
  it('reads a tool block and keeps the prose', () => {
    const r = fin(`Reading it.\n${T}tool\n{"tool":"read","args":{"path":"a.txt"}}\n${T}`)
    expect(r).toEqual({ kind: 'calls', text: 'Reading it.', calls: [{ id: 'c1', tool: 'read', args: { path: 'a.txt' } }] })
  })

  it('orders several blocks by position', () => {
    const r = fin(`${T}tool\n{"tool":"a"}\n${T}\nmid\n${T}tool\n{"tool":"b","args":{"x":1}}\n${T}`)
    expect(r.kind === 'calls' && r.calls.map((c) => c.tool)).toEqual(['a', 'b'])
  })

  it('accepts a json/unlabelled fence only when it says "tool"', () => {
    expect(fin(`${T}json\n{"tool":"read","args":{}}\n${T}`).kind).toBe('calls')
    expect(fin(`${T}\n{"tool":"read","args":{}}\n${T}`).kind).toBe('calls')
    const code = fin(`${T}json\n{"name":"x","value":1}\n${T}`)
    expect(code.kind).toBe('text')
    expect(code.text).toContain('"value":1') // ordinary code stays in the prose
  })

  it('accetta gli argomenti accanto a "tool" quando manca "args"', () => {
    const r = fin(`${T}tool\n{"tool":"bash","command":"git status"}\n${T}`)
    expect(r.kind === 'calls' && r.calls[0]).toEqual({ id: 'c1', tool: 'bash', args: { command: 'git status' } })
    const f = fin(`${T}tool\n{"tool":"finish"}\n${T}`)
    expect(f.kind === 'calls' && f.calls[0]!.args).toEqual({})
    const wrapped = fin(`${T}tool\n{"tool":"read","args":{"path":"a"},"extra":1}\n${T}`)
    expect(wrapped.kind === 'calls' && wrapped.calls[0]!.args).toEqual({ path: 'a' }) // "args" wins
  })

  it('is incomplete while streaming and invalid when final', () => {
    const cut = `ok\n${T}tool\n{"tool":"write","args":{"pa`
    expect(parseReply(cut, { final: false }).kind).toBe('incomplete')
    const f = fin(cut)
    expect(f.kind).toBe('invalid')
    expect(f.kind === 'invalid' && f.errors.join()).toMatch(/never closed/)
  })

  it('reports bad JSON and a missing tool name', () => {
    expect(fin(`${T}tool\n{"tool": nope}\n${T}`).kind).toBe('invalid')
    const r = fin(`${T}tool\n{"args":{}}\n${T}`)
    expect(r.kind === 'invalid' && r.errors[0]).toMatch(/missing string field "tool"/)
  })

  it('repairs raw newlines and trailing commas but never edits string contents', () => {
    const r = fin(`${T}tool\n{"tool":"write","args":{"content":"a\nb",},}\n${T}`)
    expect(r.kind === 'calls' && r.calls[0]!.args).toEqual({ content: 'a\nb' })
    expect(lenientParse('{"s":"a,}","t":[1,2,],}')).toEqual({ s: 'a,}', t: [1, 2] })
  })

  it('keeps escaped fences inside a JSON string intact', () => {
    const r = fin(`${T}tool\n{"tool":"write","args":{"content":"x\\n${T}js\\ny\\n${T}"}}\n${T}`)
    expect(r.kind === 'calls' && (r.calls[0]!.args as { content: string }).content).toContain(`${T}js`)
  })

  it('understands <tool_call> markup with name/arguments', () => {
    const r = fin('<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>')
    expect(r.kind === 'calls' && r.calls[0]).toEqual({ id: 'c1', tool: 'read', args: { path: 'a' } })
    const s = fin('<tool_call>{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}</tool_call>')
    expect(s.kind === 'calls' && s.calls[0]!.args).toEqual({ path: 'a' })
    expect(parseReply('<tool_call>{"name":"re', { final: false }).kind).toBe('incomplete')
  })

  it('classifies plain prose as text', () => {
    expect(fin('Sure, here is the answer.')).toEqual({ kind: 'text', text: 'Sure, here is the answer.' })
  })

  it('detects the site answering with its own tool error, only at the start', () => {
    expect(fin('Tool read does not exists.').kind).toBe('native_tool_failure')
    expect(fin('x'.repeat(250) + ' Tool read does not exist').kind).toBe('text')
  })
})
