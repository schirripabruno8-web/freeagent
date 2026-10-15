import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@contracts/agent'
import type { ApprovalRequest, PermissionMode } from '@contracts/permissions'
import type { ProviderAdapter } from '@contracts/provider'
import { runAgent } from './agent/loop'
import { CheckpointStore } from './checkpoint'
import { makeAuthorizer } from './permissions'
import { createSandbox } from './sandbox'
import { allTools } from './tool-registry'

// The real pieces together: loop + authorizer + sandbox + tools + checkpoint store. Only the chat site is faked.
const T = '```'
const call = (tool: string, args: unknown) => `${T}tool\n${JSON.stringify({ tool, args })}\n${T}`

let base: string
let ws: string
let outside: string
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-e2e-')))
  ws = path.join(base, 'work')
  outside = path.join(base, 'secret')
  mkdirSync(ws)
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'k.txt'), 'TOP-SECRET')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

async function session(replies: string[], mode: PermissionMode, answers: boolean[] = []) {
  const sent: string[] = []
  let i = 0
  const adapter: ProviderAdapter = {
    id: 'fake', status: async () => ({ loggedIn: true, url: '' }), listModels: async () => [], selectModel: async () => {},
    newChat: async () => {}, send: async (t) => void sent.push(t), selfTest: async () => ({ ok: true, checks: [] }),
    stream: async function* () {
      const r = replies[i++] ?? call('finish', { summary: 'script over' })
      yield { text: r, done: true }
    }
  }
  const store = new CheckpointStore(path.join(base, 'ckpt'))
  const asked: Omit<ApprovalRequest, 'id'>[] = []
  const sandbox = createSandbox(ws)
  const cwd = sandbox.resolve('.', false)
  const events: AgentEvent[] = []
  const report = await runAgent({
    adapter, tools: allTools, task: 't', cwd, sandbox,
    checkpoint: (tool, files) => store.create(tool, files),
    authorize: makeAuthorizer({
      cwd, sandbox, getMode: () => mode, allowlist: () => ['echo'],
      requestApproval: async (r) => (asked.push(r), answers.shift() ?? false)
    }),
    emit: (e) => events.push(e)
  })
  return { report, sent, asked, store, events }
}

describe('Fase 1 end-to-end', () => {
  it('modo ask: edit approvato -> file cambiato -> checkpoint -> ripristino riporta il file com\'era', async () => {
    writeFileSync(path.join(ws, 'a.txt'), 'uno\ndue\n')
    const s = await session(
      [call('edit', { path: 'a.txt', old_string: 'due', new_string: 'DUE' }), call('finish', { summary: 'ok' })],
      'ask',
      [true]
    )
    expect(s.report.reason).toBe('finish')
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0]!.detail).toContain('+DUE')
    expect(readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('uno\nDUE\n')
    const [cp] = await s.store.list()
    expect(cp).toMatchObject({ tool: 'edit' })
    await s.store.restoreTo(cp!.id)
    expect(readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('uno\ndue\n')
  })

  it('modo ask: se l\'utente nega, il file NON cambia e il modello lo sa', async () => {
    writeFileSync(path.join(ws, 'a.txt'), 'uno')
    const s = await session([call('write', { path: 'a.txt', content: 'X' }), call('finish', { summary: 'ok' })], 'ask', [false])
    expect(readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('uno')
    expect(s.sent[1]).toContain('denied: the user declined')
    expect(await s.store.list()).toEqual([])
  })

  it('modo auto: scrive dentro senza chiedere; fuori chiede e, negato, non tocca nulla', async () => {
    const s = await session(
      [
        call('write', { path: 'sub/new.txt', content: 'ciao' }),
        call('write', { path: '../secret/k.txt', content: 'PWNED' }),
        call('finish', { summary: 'ok' })
      ],
      'auto',
      [false]
    )
    expect(readFileSync(path.join(ws, 'sub', 'new.txt'), 'utf8')).toBe('ciao')
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0]).toMatchObject({ kind: 'outside', outside: true })
    expect(readFileSync(path.join(outside, 'k.txt'), 'utf8')).toBe('TOP-SECRET')
  })

  it('fuori dalla cartella: se approvato funziona, altrimenti il tool stesso rifiuta anche se un bug lo chiamasse', async () => {
    const s = await session([call('read', { path: '../secret/k.txt' }), call('finish', { summary: 'ok' })], 'ask', [true])
    expect(s.sent[1]).toContain('TOP-SECRET')
    const t = await session([call('read', { path: '../secret/k.txt' }), call('finish', { summary: 'ok' })], 'ask', [false])
    expect(t.sent[1]).not.toContain('TOP-SECRET')
  })

  it('nomi vietati (ADS, CON) vengono negati senza disturbare l\'utente', async () => {
    const s = await session(
      [call('write', { path: 'a.txt:hidden', content: 'x' }), call('read', { path: 'CON' }), call('finish', { summary: 'ok' })],
      'auto'
    )
    expect(s.asked).toEqual([])
    expect(s.sent[1]).toContain('path refused')
  })

  it('sola lettura: legge, ma write, edit e bash sono negati', async () => {
    writeFileSync(path.join(ws, 'a.txt'), 'uno')
    const s = await session(
      [
        [call('read', { path: 'a.txt' }), call('write', { path: 'b.txt', content: 'x' })].join('\n'),
        call('bash', { command: 'echo hi' }),
        call('finish', { summary: 'ok' })
      ],
      'readonly'
    )
    expect(s.sent[1]).toContain('uno')
    expect(s.sent[1]).toContain('read-only mode')
    expect(s.sent[2]).toContain('read-only mode')
    expect(existsSync(path.join(ws, 'b.txt'))).toBe(false)
    expect(s.asked).toEqual([])
  })

  it('bash: in allowlist passa senza chiedere; fuori allowlist chiede', async () => {
    const s = await session([call('bash', { command: 'echo ciao' }), call('bash', { command: 'pwd' }), call('finish', { summary: 'ok' })], 'ask', [false])
    expect(s.sent[1]).toContain('ciao')
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0]).toMatchObject({ kind: 'bash', summary: 'bash: pwd' })
    expect(s.sent[2]).toContain('denied: the user declined')
  })

  it('grep e glob: trovano dentro e non escono dalla cartella', async () => {
    writeFileSync(path.join(ws, 'a.ts'), 'const needle = 1\n')
    const s = await session([call('grep', { pattern: 'needle' }), call('glob', { pattern: '**/*.ts' }), call('finish', { summary: 'ok' })], 'ask')
    expect(s.sent[1]).toContain('a.ts:1: const needle = 1')
    expect(s.sent[2]).toContain('a.ts')
    expect(s.sent[1]! + s.sent[2]!).not.toContain('TOP-SECRET')
  })
})
