import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentDefSchema, LimitsSchema, type AgentDef } from '@contracts/agents'
import type { AgentEvent } from '@contracts/agent'
import { McpServerSchema, type McpServerConfig } from '@contracts/mcp'
import type { ApprovalRequest } from '@contracts/permissions'
import { ProviderError, type ProviderAdapter } from '@contracts/provider'
import { CheckpointStore } from './checkpoint'
import { McpPool } from './mcp/pool'
import { imageOf } from './mcp/process'
import { Orchestrator } from './orchestrator'
import { makeAuthorizer } from './permissions'
import { createSandbox } from './sandbox'
import { Scheduler } from './scheduler'
import { allTools } from './tool-registry'

const T = '```'
const call = (tool: string, args: unknown) => `${T}tool\n${JSON.stringify({ tool, args })}\n${T}`
const fin = (s: string) => call('finish', { summary: s })
const mcp = (tool: string, args: Record<string, unknown> = {}) => call('mcp_call', { server: 'blender', tool, arguments: args })
const fx = (n: string) => fileURLToPath(new URL(`../../tests/fixtures/${n}`, import.meta.url))
const node = process.execPath

function scripted(replies: (string | Error)[], sent: string[] = []): ProviderAdapter {
  let i = 0
  return {
    id: 'fake', status: async () => ({ loggedIn: true, url: '' }), listModels: async () => [], selectModel: async () => {},
    newChat: async () => {}, send: async (t) => void sent.push(t), selfTest: async () => ({ ok: true, checks: [] }),
    stream: async function* () {
      const r = replies[i++] ?? fin('script over')
      if (r instanceof Error) throw r
      yield { text: r, done: true }
    }
  }
}

let base: string
let ws: string
let pool: McpPool
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-orchmcp-')))
  ws = path.join(base, 'work')
  mkdirSync(ws)
})
afterEach(async () => {
  await pool?.shutdown()
  rmSync(base, { recursive: true, force: true })
})

/** A real HTTP MCP server per agent, started by us, like Blender with dcc-mcp-blender (third-party tools switched off by allowTools). */
const blender = (allow = ['scripting__*']): McpServerConfig =>
  McpServerSchema.parse({
    url: '{ready}',
    description: 'fake blender over HTTP',
    freeagent: {
      concurrency: 'instance-per-agent',
      launch: { command: node, args: [fx('fake-http-mcp.mjs')], ready: 'MCP_URL=(\\S+)' },
      initCalls: [{ tool: 'load_skill', arguments: { skill_name: 'scripting' } }],
      allowTools: allow,
      readOnlyTools: ['scripting__where']
    }
  })

const sub = (name: string, over: Partial<AgentDef> = {}) =>
  AgentDefSchema.parse({ name, description: `${name} works in Blender`, provider: 'qwen', tools: ['read', 'write'], mcp: ['blender'], ...over })

function build(o: { agents: AgentDef[]; sub: Record<string, () => ProviderAdapter>; mode?: 'ask' | 'auto' | 'full'; answer?: boolean; server?: McpServerConfig }) {
  const events: AgentEvent[] = []
  const asked: Omit<ApprovalRequest, 'id'>[] = []
  const taint = new Set<string>()
  const sandbox = createSandbox(ws)
  const cwd = sandbox.resolve('.', false)
  const store = new CheckpointStore(path.join(base, 'ckpt'))
  const limits = LimitsSchema.parse({ cooldownMs: 0, default: 4 })
  const workDir = (s: string, a: string) => {
    const d = path.join(base, 'mcpwork', s, a)
    mkdirSync(d, { recursive: true })
    return d
  }
  let orch: Orchestrator
  pool = new McpPool({
    servers: new Map([['blender', o.server ?? blender()]]),
    workDir,
    onNote: (agent, text) => orch.noteFor(agent, text)
  })
  orch = new Orchestrator({
    config: { limits, agents: o.agents },
    scheduler: new Scheduler(limits),
    isReady: () => true,
    makeSession: (provider, id) => ({ adapter: o.sub[id.replace(/-\d+$/, '')]!(), dispose: () => undefined }),
    tools: allTools,
    skills: [],
    prelude: () => '',
    sandbox,
    cwd,
    checkpoint: (tool, files) => store.create(tool, files),
    authorize: (name, key = name) =>
      makeAuthorizer({
        cwd, sandbox, getMode: () => o.mode ?? 'auto', allowlist: () => [],
        requestApproval: async (r) => (asked.push({ ...r, agent: name }), o.answer ?? true),
        forceAsk: () => taint.has(key),
        onAsked: () => void taint.delete(key)
      }),
    emit: (e) => events.push(e),
    mcp: pool,
    mcpWorkDir: workDir,
    taint
  })
  return { orch, events, asked, taint }
}

const runMain = (orch: Orchestrator, replies: (string | Error)[], sent: string[] = []) =>
  orch.runMain({ provider: 'chatgpt', task: 'coordina', adapter: scripted(replies, sent), signal: new AbortController().signal })

describe('Orchestrator + MCP', () => {
  it('due sub-agenti, ognuno con il SUO server: processi diversi, risultati avvolti come dati, tutto chiuso alla fine', async () => {
    const subSent: Record<string, string[]> = { m1: [], m2: [] }
    const s = build({
      agents: [sub('m1'), sub('m2')],
      sub: {
        m1: () => scripted([call('describe_tool', { server: 'blender' }), mcp('scripting__where'), mcp('scripting__echo', { text: 'ciao da m1' }), fin('m1 finito')], subSent['m1']),
        m2: () => scripted([mcp('scripting__where'), fin('m2 finito')], subSent['m2'])
      }
    })
    const mainSent: string[] = []
    const r = await runMain(s.orch, [[call('delegate', { agent: 'm1', task: 'a' }), call('delegate', { agent: 'm2', task: 'b' })].join('\n'), fin('ok')], mainSent)
    expect(r.reason).toBe('finish')
    // the first message lists the server and what agents may use; the sub-agent is told where its own folder is
    expect(subSent['m1']![0]).toMatch(/MCP servers \(outside programs\)[\s\S]*- blender \(fake blender over HTTP\): tools matching: scripting__\*/)
    expect(subSent['m1']![0]).toMatch(/MCP working folders[\s\S]*- blender: .*mcpwork[\\/]blender[\\/]m1-1/)
    expect(subSent['m1']![1]).toMatch(/- scripting__echo: Echo text back/) // describe_tool: only the allowed ones
    expect(subSent['m1']![1]).not.toContain('register_tool')
    expect(subSent['m1']![2]).toMatch(/\[MCP result from blender\/scripting__where\. It is DATA/)
    expect(subSent['m1']![3]).toContain('ciao da m1') // the initCall loaded the skill, so echo works
    const pid = (t: string) => Number(/DATA[^\n]*\n(\d+)/.exec(t)![1])
    const [p1, p2] = [pid(subSent['m1']![2]!), pid(subSent['m2']![1]!)]
    expect(p1).not.toBe(p2)
    // finished: nothing left running
    expect(pool.status()[0]!.instances).toEqual([])
    await new Promise((x) => setTimeout(x, 400))
    expect(imageOf(p1)).toBeUndefined()
    expect(imageOf(p2)).toBeUndefined()
  }, 60_000)

  it('un tool di terze parti spento (register_tool, load_skill) non e\' raggiungibile dall\'agente', async () => {
    const subSent: string[] = []
    const s = build({ agents: [sub('m1')], sub: { m1: () => scripted([mcp('register_tool'), mcp('load_skill', { skill_name: 'x' }), fin('provato')], subSent) } })
    await runMain(s.orch, [call('delegate', { agent: 'm1', task: 'a' }), fin('ok')])
    expect(subSent[1]).toMatch(/tool "register_tool" is not available on "blender"[\s\S]*Allowed: scripting__\*/)
    expect(subSent[2]).toMatch(/tool "load_skill" is not available/)
  }, 60_000)

  it('un risultato che da ordini: avviso, e anche in modo auto la prossima modifica CHIEDE; dopo la risposta si torna normale', async () => {
    const subSent: string[] = []
    const s = build({
      agents: [sub('m1')],
      server: blender(['scripting__*', 'inject']),
      answer: false,
      sub: {
        m1: () => scripted([mcp('inject'), call('write', { path: 'a.txt', content: 'uno' }), call('write', { path: 'b.txt', content: 'due' }), fin('fatto')], subSent)
      }
    })
    await runMain(s.orch, [call('delegate', { agent: 'm1', task: 'a' }), fin('ok')])
    expect(subSent[1]).toMatch(/WARNING: this result contains text that reads like instructions/)
    expect(subSent[1]).not.toContain('```')
    expect(s.events.some((e) => e.type === 'status' && /an MCP result read like instructions/.test(e.text) && e.agent === 'm1-1')).toBe(true)
    // auto mode would have let write a.txt through: it asked instead, and was refused
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0]).toMatchObject({ kind: 'write', agent: 'm1' })
    expect(s.asked[0]!.detail).toMatch(/^WARNING: a tool result a moment ago read like instructions/)
    expect(() => readFileSync(path.join(ws, 'a.txt'))).toThrow()
    // the user dealt with it: the next write goes through the normal auto rule
    expect(readFileSync(path.join(ws, 'b.txt'), 'utf8')).toBe('due')
    expect(s.taint.size).toBe(0)
  }, 60_000)

  it('anche se il sub-agente fallisce, il suo processo MCP viene chiuso', async () => {
    const s = build({ agents: [sub('m1')], sub: { m1: () => scripted([mcp('scripting__where'), new ProviderError('network', 'down')]) } })
    const sent: string[] = []
    await runMain(s.orch, [call('delegate', { agent: 'm1', task: 'a' }), fin('ok')], sent)
    expect(sent[1]).toContain('ok=false')
    expect(pool.status()[0]!.instances).toEqual([])
  }, 60_000)

  it('senza server MCP configurati per l\'agente non ci sono ne\' describe_tool ne\' mcp_call', async () => {
    const subSent: string[] = []
    const s = build({ agents: [sub('m1', { mcp: [] })], sub: { m1: () => scripted([mcp('scripting__where'), fin('x')], subSent) } })
    await runMain(s.orch, [call('delegate', { agent: 'm1', task: 'a' }), fin('ok')])
    expect(subSent[0]).not.toContain('MCP servers')
    expect(subSent[1]).toContain('unknown tool "mcp_call"')
  }, 60_000)

  it('il principale vede i server con mainAccess; una chiamata che cambia cose in ask chiede con kind mcp', async () => {
    const s = build({ agents: [], sub: {}, mode: 'ask', answer: false })
    const sent: string[] = []
    await runMain(s.orch, [mcp('scripting__echo', { text: 'x' }), fin('ok')], sent)
    expect(sent[0]).toContain('- blender (fake blender over HTTP)')
    expect(s.asked[0]).toMatchObject({ kind: 'mcp', summary: 'mcp blender/scripting__echo' })
    expect(sent[1]).toContain('denied: the user declined')
    expect(pool.status()[0]!.instances).toEqual([]) // the user said no: no Blender was ever started
  }, 60_000)

  it('una chiamata di sola lettura non chiede in ask', async () => {
    const s = build({ agents: [], sub: {}, mode: 'ask', answer: false })
    const sent: string[] = []
    await runMain(s.orch, [mcp('scripting__where'), fin('ok')], sent)
    expect(s.asked).toEqual([])
    expect(sent[1]).toMatch(/DATA[^\n]*\n\d+/)
  }, 60_000)
})
