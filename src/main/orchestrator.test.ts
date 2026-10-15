import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentDefSchema, LimitsSchema, type AgentDef, type Limits } from '@contracts/agents'
import type { AgentEvent } from '@contracts/agent'
import type { ApprovalRequest, PermissionMode } from '@contracts/permissions'
import { ProviderError, type ProviderAdapter } from '@contracts/provider'
import { CheckpointStore } from './checkpoint'
import { Orchestrator } from './orchestrator'
import { makeAuthorizer } from './permissions'
import { createSandbox } from './sandbox'
import { Scheduler } from './scheduler'
import { allTools } from './tool-registry'

const T = '```'
const call = (tool: string, args: unknown) => `${T}tool\n${JSON.stringify({ tool, args })}\n${T}`
const fin = (s: string) => call('finish', { summary: s })
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('aborted', 'aborted'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new ProviderError('aborted', 'aborted'))), { once: true })
  })

/** A chat that answers from a script, after `delay` ms per reply. `hang` = never answers until stopped. */
function scripted(replies: (string | Error)[], opts: { delay?: number; hang?: boolean; sent?: string[] } = {}): ProviderAdapter {
  let i = 0
  return {
    id: 'fake', status: async () => ({ loggedIn: true, url: '' }), listModels: async () => [], selectModel: async () => {},
    newChat: async () => {}, send: async (t) => void opts.sent?.push(t), selfTest: async () => ({ ok: true, checks: [] }),
    stream: async function* (signal) {
      if (opts.hang) await wait(60_000, signal)
      await wait(opts.delay ?? 0, signal)
      const r = replies[i++] ?? fin('script over')
      if (r instanceof Error) throw r
      yield { text: r, done: true }
    }
  }
}

let base: string
let ws: string
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-orch-')))
  ws = path.join(base, 'work')
  mkdirSync(ws)
  writeFileSync(path.join(ws, 'a.txt'), 'contenuto-di-a')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const analyst = (over: Partial<AgentDef> = {}) =>
  AgentDefSchema.parse({ name: 'analyst', description: 'reads and analyses', provider: 'qwen', tools: ['read', 'glob', 'grep'], ...over })
const editor = (over: Partial<AgentDef> = {}) =>
  AgentDefSchema.parse({ name: 'editor', description: 'edits files', provider: 'deepseek', tools: ['read', 'write', 'edit'], ...over })

function build(o: {
  agents: AgentDef[]
  limits?: Partial<Limits>
  /** reply script for a sub-agent session, by agent name (the session id is "<name>-<n>") */
  sub?: Record<string, (provider: string, n: number) => ProviderAdapter>
  ready?: string[]
  mode?: PermissionMode
  answer?: boolean
  skills?: { name: string; description: string; body: string; source: 'bundled' | 'user' }[]
  prelude?: string
  /** the chat that sees images (look); `attach` lists the providers whose page takes attachments (default: qwen) */
  vision?: { provider: string; model?: string; maxCalls?: number }
  attach?: string[]
}) {
  const events: AgentEvent[] = []
  const asked: Omit<ApprovalRequest, 'id'>[] = []
  const sessions: { provider: string; id: string }[] = []
  const used: string[] = []
  let live = 0
  let peak = 0
  const sandbox = createSandbox(ws)
  const cwd = sandbox.resolve('.', false)
  const store = new CheckpointStore(path.join(base, 'ckpt'))
  const limits = LimitsSchema.parse({ cooldownMs: 0, default: 1, ...o.limits })
  const scheduler = new Scheduler(limits)
  const orch = new Orchestrator({
    config: { limits, agents: o.agents, ...(o.vision ? { vision: { maxCalls: 10, ...o.vision } } : {}) },
    scheduler,
    hasAttach: (p) => (o.attach ?? ['qwen']).includes(p),
    isReady: (p) => (o.ready ?? ['qwen', 'deepseek', 'kimi', 'chatgpt']).includes(p),
    makeSession: (provider, id) => {
      sessions.push({ provider, id })
      live++
      peak = Math.max(peak, live)
      const name = id.replace(/-\d+$/, '')
      const n = sessions.filter((s) => s.id.startsWith(name)).length
      return { adapter: o.sub![name]!(provider, n), dispose: () => void live-- }
    },
    tools: allTools,
    skills: o.skills ?? [],
    prelude: () => o.prelude ?? '',
    sandbox,
    cwd,
    checkpoint: (tool, files) => store.create(tool, files),
    authorize: (name) =>
      makeAuthorizer({
        cwd, sandbox, getMode: () => o.mode ?? 'auto', allowlist: () => [],
        requestApproval: async (r) => (asked.push({ ...r, agent: name }), o.answer ?? true)
      }),
    emit: (e) => events.push(e),
    onSend: (p) => used.push(p)
  })
  return { orch, events, asked, sessions, used, scheduler, peak: () => peak, live: () => live, store }
}

const runMain = (orch: Orchestrator, replies: (string | Error)[], sent: string[] = [], signal = new AbortController().signal) =>
  orch.runMain({ provider: 'chatgpt', task: 'coordina', adapter: scripted(replies, { sent }), signal })

describe('Orchestrator: delega', () => {
  it('il principale delega in parallelo a due sub-agenti su provider diversi e riceve i due rapporti', async () => {
    const s = build({
      agents: [analyst(), editor()],
      sub: {
        analyst: (p) => scripted([call('read', { path: 'a.txt' }), fin('a.txt contiene contenuto-di-a')], { delay: 120 }),
        editor: () => scripted([call('write', { path: 'out.txt', content: 'scritto' }), fin('creato out.txt')], { delay: 120 })
      }
    })
    const sent: string[] = []
    const t0 = Date.now()
    const r = await runMain(
      s.orch,
      [[call('delegate', { agent: 'analyst', task: 'leggi a.txt' }), call('delegate', { agent: 'editor', task: 'scrivi out.txt' })].join('\n'), fin('tutto fatto')],
      sent
    )
    expect(r).toMatchObject({ reason: 'finish', summary: 'tutto fatto' })
    // 2 replies x 120 ms each if sequential = 480+; in parallel the two subs overlap
    expect(Date.now() - t0).toBeLessThan(450)
    expect(s.peak()).toBe(2)
    expect(sent[1]).toContain('[analyst on qwen] done')
    expect(sent[1]).toContain('a.txt contiene contenuto-di-a')
    expect(sent[1]).toContain('[editor on deepseek] done')
    expect(readFileSync(path.join(ws, 'out.txt'), 'utf8')).toBe('scritto')
    expect(s.sessions.map((x) => x.provider).sort()).toEqual(['deepseek', 'qwen'])
    expect(s.live()).toBe(0) // both browser windows closed
    expect(s.used.sort()).toEqual(['chatgpt', 'chatgpt', 'deepseek', 'deepseek', 'qwen', 'qwen']) // every message counted per provider
  })

  it('gli eventi dei sub-agenti portano il loro id; solo il principale chiude il task', async () => {
    const s = build({ agents: [analyst()], sub: { analyst: () => scripted([fin('ok')]) } })
    await runMain(s.orch, [call('delegate', { agent: 'analyst', task: 't' }), fin('x')])
    const finished = s.events.filter((e) => e.type === 'finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]!.agent).toBeUndefined()
    const sub = s.events.filter((e) => e.agent === 'analyst-1')
    expect(sub.length).toBeGreaterThan(0)
    expect(sub.some((e) => e.type === 'finished')).toBe(false)
    const states = s.events.flatMap((e) => (e.type === 'agent' && e.id === 'analyst-1' ? [e.status] : []))
    expect(states).toEqual(['queued', 'running', 'done'])
    const main = s.events.flatMap((e) => (e.type === 'agent' && e.id === 'main' ? [e.status] : []))
    expect(main).toEqual(['queued', 'running', 'done'])
  })

  it('senza sub-agenti definiti il tool delegate non esiste', async () => {
    const s = build({ agents: [], sub: {} })
    const sent: string[] = []
    await runMain(s.orch, [call('delegate', { agent: 'x', task: 't' }), fin('x')], sent)
    expect(sent[0]).not.toContain('delegate')
    expect(sent[1]).toContain('unknown tool "delegate"')
  })

  it('un sub-agente usa SOLO i suoi tool e non puo\' delegare a sua volta', async () => {
    const sent: string[] = []
    const s = build({
      agents: [analyst()],
      sub: {
        analyst: () =>
          scripted([call('write', { path: 'x.txt', content: 'no' }), call('delegate', { agent: 'analyst', task: 'loop' }), fin('provato')], { sent })
      }
    })
    await runMain(s.orch, [call('delegate', { agent: 'analyst', task: 't' }), fin('x')])
    expect(sent[1]).toContain('unknown tool "write"')
    expect(sent[2]).toContain('unknown tool "delegate"')
    expect(() => readFileSync(path.join(ws, 'x.txt'))).toThrow()
    expect(sent[0]).toContain('ROLE: analyst: reads and analyses')
  })

  it('anche se la config elenca "delegate" tra i tool di un sub-agente, non lo riceve (niente ricorsione)', async () => {
    const sent: string[] = []
    const s = build({
      agents: [analyst({ tools: ['read', 'delegate'] })],
      sub: { analyst: () => scripted([call('delegate', { agent: 'analyst', task: 'ancora' }), fin('ok')], { sent }) }
    })
    await runMain(s.orch, [call('delegate', { agent: 'analyst', task: 't' }), fin('x')])
    expect(sent[1]).toContain('unknown tool "delegate"')
    expect(s.sessions).toHaveLength(1) // no second-level sub-agent was ever opened
  })

  it('agente sconosciuto: errore chiaro con i nomi validi', async () => {
    const s = build({ agents: [analyst()], sub: {} })
    const sent: string[] = []
    await runMain(s.orch, [call('delegate', { agent: 'ghost', task: 't' }), fin('x')], sent)
    expect(sent[1]).toMatch(/unknown agent, use one of: analyst/)
  })
})

describe('Orchestrator: limiti e provider', () => {
  it('limite 1 per provider: due sub-agenti sullo stesso provider vanno in fila', async () => {
    const s = build({
      agents: [analyst({ name: 'a1' }), analyst({ name: 'a2' })],
      limits: { default: 1 },
      sub: { a1: () => scripted([fin('1')], { delay: 60 }), a2: () => scripted([fin('2')], { delay: 60 }) }
    })
    await runMain(s.orch, [[call('delegate', { agent: 'a1', task: 't' }), call('delegate', { agent: 'a2', task: 't' })].join('\n'), fin('x')])
    expect(s.peak()).toBe(1)
    expect(s.sessions).toHaveLength(2)
  })

  it('limite raggiunto: il provider riposa e il compito ripiega sul provider di riserva', async () => {
    const s = build({
      agents: [analyst({ fallback: ['kimi'] })],
      sub: { analyst: (p) => (p === 'qwen' ? scripted([new ProviderError('rate_limit', 'too many requests')]) : scripted([fin('fatto da kimi')])) }
    })
    const sent: string[] = []
    await runMain(s.orch, [call('delegate', { agent: 'analyst', task: 't' }), fin('x')], sent)
    expect(s.sessions.map((x) => x.provider)).toEqual(['qwen', 'kimi'])
    expect(sent[1]).toContain('[analyst on kimi] done')
    expect(sent[1]).toContain('fatto da kimi')
    expect(s.scheduler.limitedUntil('qwen')).toBeDefined()
    expect(s.live()).toBe(0)
  })

  it('tutti i provider limitati oltre l\'attesa massima: errore chiaro al principale, che puo\' decidere', async () => {
    const s = build({
      agents: [analyst()],
      limits: { maxWaitMs: 1000 },
      sub: { analyst: () => scripted([fin('mai')]) }
    })
    s.scheduler.markLimited('qwen', Date.now() + 30 * 60_000)
    const sent: string[] = []
    const r = await runMain(s.orch, [call('delegate', { agent: 'analyst', task: 't' }), fin('rinuncio')], sent)
    expect(sent[1]).toContain('ok=false')
    expect(sent[1]).toMatch(/could not run: its providers are rate-limited/)
    expect(r.summary).toBe('rinuncio')
    expect(s.sessions).toEqual([])
  })

  it('provider non pronto e senza riserva: errore che dice come catturare i selettori', async () => {
    const s = build({ agents: [analyst()], ready: ['chatgpt'], sub: {} })
    const sent: string[] = []
    await runMain(s.orch, [call('delegate', { agent: 'analyst', task: 't' }), fin('x')], sent)
    expect(sent[1]).toMatch(/no ready provider for "analyst".*npm run inspect/)
  })

  it('il principale non parte su un provider che sta riposando', async () => {
    const s = build({ agents: [], sub: {} })
    s.scheduler.markLimited('chatgpt', Date.now() + 60_000)
    const r = await runMain(s.orch, [fin('x')])
    expect(r).toMatchObject({ reason: 'error', errorKind: 'rate_limit' })
    expect(r.summary).toMatch(/limit reached/)
  })

  it('un limite sul principale lo mette a riposo per i prossimi task', async () => {
    const s = build({ agents: [], sub: {} })
    const r = await runMain(s.orch, [new ProviderError('rate_limit', 'stop')])
    expect(r.errorKind).toBe('rate_limit')
    expect(s.scheduler.limitedUntil('chatgpt')).toBeDefined()
  })
})

describe('Orchestrator: permessi e Stop', () => {
  it('le richieste di approvazione di un sub-agente portano il suo nome; negate, il file non cambia', async () => {
    const s = build({
      agents: [editor()],
      mode: 'ask',
      answer: false,
      sub: { editor: () => scripted([call('write', { path: 'out.txt', content: 'x' }), fin('provato')]) }
    })
    const sent: string[] = []
    await runMain(s.orch, [call('delegate', { agent: 'editor', task: 't' }), fin('x')], sent)
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0]).toMatchObject({ kind: 'write', agent: 'editor' })
    expect(() => readFileSync(path.join(ws, 'out.txt'))).toThrow()
  })

  it('Stop ferma principale e sub-agenti, libera le finestre e gli slot', async () => {
    const s = build({ agents: [analyst(), editor()], sub: { analyst: () => scripted([], { hang: true }), editor: () => scripted([], { hang: true }) } })
    const ac = new AbortController()
    const done = runMain(s.orch, [[call('delegate', { agent: 'analyst', task: 't' }), call('delegate', { agent: 'editor', task: 't' })].join('\n')], [], ac.signal)
    await wait(150)
    expect(s.live()).toBe(2)
    ac.abort()
    const r = await done
    expect(r.reason).toBe('aborted')
    expect(s.live()).toBe(0)
    expect(s.scheduler.snapshot().qwen).toMatchObject({ running: 0, queued: 0 })
    expect(s.scheduler.snapshot().deepseek).toMatchObject({ running: 0, queued: 0 })
    const last = s.events.flatMap((e) => (e.type === 'agent' && e.id !== 'main' ? [`${e.id}:${e.status}`] : []))
    expect(last).toContain('analyst-1:stopped')
    expect(last).toContain('editor-2:stopped')
  })

  it('i checkpoint dei sub-agenti finiscono nello stesso store e si possono annullare', async () => {
    writeFileSync(path.join(ws, 'a.txt'), 'prima')
    const s = build({
      agents: [editor()],
      sub: { editor: () => scripted([call('edit', { path: 'a.txt', old_string: 'prima', new_string: 'dopo' }), fin('ok')]) }
    })
    await runMain(s.orch, [call('delegate', { agent: 'editor', task: 't' }), fin('x')])
    expect(readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('dopo')
    const [cp] = await s.store.list()
    await s.store.restoreTo(cp!.id)
    expect(readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('prima')
  })
})

describe('Orchestrator: skill e regole sempre attive', () => {
  const skills = [
    { name: 'ponytail', description: 'lazy dev', body: 'REGOLE-PONYTAIL', source: 'bundled' as const },
    { name: 'other', description: 'altra skill', body: 'CORPO-OTHER', source: 'user' as const }
  ]

  it('il principale vede tutte le skill e le carica on demand; il prelude e\' nel suo primo messaggio', async () => {
    const s = build({ agents: [], skills, prelude: 'ACTIVE SKILL: ponytail ultra', sub: {} })
    const sent: string[] = []
    await runMain(s.orch, [call('load_skill', { name: 'other' }), fin('x')], sent)
    expect(sent[0]).toContain('- ponytail: lazy dev')
    expect(sent[0]).toContain('- other: altra skill')
    expect(sent[0]).toContain('ACTIVE SKILL: ponytail ultra')
    expect(sent[1]).toContain('CORPO-OTHER')
  })

  it('un sub-agente riceve il prelude e SOLO le skill della sua definizione', async () => {
    const subSent: string[] = []
    const s = build({
      agents: [analyst({ skills: ['other'] })],
      skills,
      prelude: 'ACTIVE SKILL: ponytail full',
      sub: { analyst: () => scripted([call('load_skill', { name: 'ponytail' }), call('load_skill', { name: 'other' }), fin('ok')], { sent: subSent }) }
    })
    await runMain(s.orch, [call('delegate', { agent: 'analyst', task: 't' }), fin('x')])
    expect(subSent[0]).toContain('ACTIVE SKILL: ponytail full') // always-on rules reach sub-agents
    expect(subSent[0]).toContain('- other: altra skill')
    expect(subSent[0]).not.toContain('- ponytail: lazy dev') // not offered as an on-demand skill
    expect(subSent[1]).toMatch(/unknown skill "ponytail"\. Available: other/)
    expect(subSent[2]).toContain('CORPO-OTHER')
  })

  it('un sub-agente senza skill non ha load_skill ne\' l\'elenco', async () => {
    const subSent: string[] = []
    const s = build({ agents: [analyst()], skills, sub: { analyst: () => scripted([call('load_skill', { name: 'other' }), fin('ok')], { sent: subSent }) } })
    await runMain(s.orch, [call('delegate', { agent: 'analyst', task: 't' }), fin('x')])
    expect(subSent[0]).not.toContain('Skills (')
    expect(subSent[1]).toContain('unknown tool "load_skill"')
  })
})

describe('Orchestrator: look (vedere le immagini)', () => {
  /** The vision chat: records what it is sent (text and image files) and answers from a script. */
  const seeing = (answers: string[], seen: { text: string; images?: string[] }[]): ProviderAdapter => ({
    ...scripted(answers),
    send: async (text, images) => void seen.push({ text, images })
  })

  it('con vision configurata il principale ha look: le immagini vanno a una chat NUOVA del provider con la vista e il verdetto torna come risultato', async () => {
    writeFileSync(path.join(ws, 'slide-01.png'), 'x')
    const seen: { text: string; images?: string[] }[] = []
    const s = build({ agents: [], vision: { provider: 'qwen' }, sub: { look: () => seeing(['Slide 1: il titolo esce dal bordo.'], seen) } })
    const sent: string[] = []
    const r = await runMain(s.orch, [call('look', { images: ['slide-01.png'], question: 'Il titolo e leggibile?' }), fin('ok')], sent)
    expect(r).toMatchObject({ reason: 'finish' })
    expect(sent[0]).toContain('look') // the tool is announced to the model
    expect(seen).toHaveLength(1)
    expect(seen[0]!.images).toEqual([path.join(realpathSync.native(ws), 'slide-01.png')])
    expect(seen[0]!.text).toContain('QUESTION: Il titolo e leggibile?')
    expect(sent[1]).toContain('Vision verdict:\nSlide 1: il titolo esce dal bordo.')
    expect(s.sessions).toEqual([{ provider: 'qwen', id: 'look-1' }])
    expect(s.live()).toBe(0) // the window of the vision chat is closed again
    expect(s.used).toContain('qwen') // the message counts against the provider
  })

  it('senza vision il tool look non esiste; con vision su un provider che non prende allegati resta spento e lo dice', async () => {
    const none = build({ agents: [] })
    const sent: string[] = []
    await runMain(none.orch, [call('look', { images: ['a.png'], question: 'q' }), fin('x')], sent)
    expect(sent[1]).toContain('unknown tool "look"')

    const blind = build({ agents: [], vision: { provider: 'qwen' }, attach: [] })
    const sent2: string[] = []
    await runMain(blind.orch, [call('look', { images: ['a.png'], question: 'q' }), fin('x')], sent2)
    expect(sent2[1]).toContain('unknown tool "look"')
    expect(blind.events).toContainEqual({ type: 'status', text: 'look is off: qwen cannot take images yet (it needs "attach" selectors)' })
  })

  it('un sub-agente ha look solo se lo elenca tra i suoi tool: anche DeepSeek, che non vede, puo usarlo', async () => {
    writeFileSync(path.join(ws, 'p.png'), 'x')
    const seen: { text: string; images?: string[] }[] = []
    const sub: string[] = []
    const s = build({
      agents: [editor({ name: 'designer', tools: ['read', 'render', 'look'] }), analyst({ name: 'plain', tools: ['read'] })],
      vision: { provider: 'qwen' },
      sub: {
        look: () => seeing(['tutto a posto'], seen),
        designer: () => ({ ...scripted([call('look', { images: ['p.png'], question: 'ok?' }), fin('verificato')]), send: async (t) => void sub.push(t) }),
        plain: () => ({ ...scripted([call('look', { images: ['p.png'], question: 'ok?' }), fin('x')]), send: async (t) => void sub.push(t) })
      }
    })
    await runMain(s.orch, [[call('delegate', { agent: 'designer', task: 'd' }), call('delegate', { agent: 'plain', task: 'p' })].join('\n'), fin('fine')])
    expect(seen).toHaveLength(1) // only the designer's call reached the vision chat
    const designer = sub.filter((t) => t.includes('Vision verdict') || t.includes('unknown tool'))
    expect(designer.some((t) => t.includes('Vision verdict:\ntutto a posto'))).toBe(true)
    expect(designer.some((t) => t.includes('unknown tool "look"'))).toBe(true) // the one that did not list it
  })

  it('provider con la vista a riposo (limite raggiunto): look risponde con un errore chiaro e non apre nessuna chat', async () => {
    writeFileSync(path.join(ws, 'p.png'), 'x')
    const s = build({ agents: [], vision: { provider: 'qwen' }, sub: { look: () => seeing(['mai'], []) } })
    s.scheduler.markLimited('qwen')
    const sent: string[] = []
    await runMain(s.orch, [call('look', { images: ['p.png'], question: 'q' }), fin('ok')], sent)
    expect(sent[1]).toContain('limit reached')
    expect(s.sessions).toEqual([])
  })

  it('tetto di chiamate per agente (vision.maxCalls): oltre, look dice di smettere di rifinire e non apre altre chat; il contatore e per esecuzione', async () => {
    writeFileSync(path.join(ws, 'p.png'), 'x')
    const seen: { text: string; images?: string[] }[] = []
    const s = build({ agents: [], vision: { provider: 'qwen', maxCalls: 2 }, sub: { look: () => seeing(['ok', 'ok'], seen) } })
    const sent: string[] = []
    const look = call('look', { images: ['p.png'], question: 'q' })
    await runMain(s.orch, [look, look, look, fin('stop')], sent)
    expect(seen).toHaveLength(2) // the third call never reached the vision chat
    expect(sent[3]).toContain('look budget used up (2 calls')
    expect(s.sessions).toHaveLength(2)
    // a new run starts again from zero
    const sent2: string[] = []
    await runMain(s.orch, [look, fin('x')], sent2)
    expect(sent2[1]).toContain('Vision verdict')
  })

  it('se il sito interrompe la risposta, look riprova una volta nella stessa chat', async () => {
    writeFileSync(path.join(ws, 'p.png'), 'x')
    let n = 0
    const flaky: ProviderAdapter = {
      ...scripted([]),
      send: async () => void n++,
      stream: async function* () {
        if (n === 1) throw new ProviderError('interrupted', 'server error')
        yield { text: 'ora si vede', done: true }
      }
    }
    const s = build({ agents: [], vision: { provider: 'qwen' }, sub: { look: () => flaky } })
    const sent: string[] = []
    await runMain(s.orch, [call('look', { images: ['p.png'], question: 'q' }), fin('ok')], sent)
    expect(n).toBe(2)
    expect(sent[1]).toContain('ora si vede')
  })
})
