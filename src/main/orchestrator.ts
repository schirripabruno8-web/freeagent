import { z } from 'zod'
import type { AgentDef, AgentsConfig } from '@contracts/agents'
import type { AgentEvent, AgentReport, Authorizer, ToolDef } from '@contracts/agent'
import type { Sandbox } from '@contracts/permissions'
import type { Skill } from '@contracts/skills'
import { ProviderError, type ProviderAdapter } from '@contracts/provider'
import { runAgent } from './agent/loop'
import type { McpBrief } from './agent/bootstrap'
import type { McpPool } from './mcp/pool'
import { makeMcpTools } from './mcp/tools'
import type { Scheduler } from './scheduler'
import { loadSkillTool } from './skills'
import { makeLookTool } from './tools/look'
import { counted } from './usage'

export interface SessionHandle {
  adapter: ProviderAdapter
  /** Closes the sub-agent's browser view. */
  dispose(): void
}

export interface OrchestratorDeps {
  config: AgentsConfig
  scheduler: Scheduler
  /** The provider has valid selectors, so it can run. */
  isReady(provider: string): boolean
  /** A fresh chat window for a sub-agent (the main agent's window comes from the caller). */
  makeSession(provider: string, agentId: string): SessionHandle
  /** The registry; `delegate` is added here and never handed to a sub-agent. */
  tools: ToolDef[]
  /** Every skill installed. The main agent may load any; a sub-agent only those listed in its definition. */
  skills: Skill[]
  /** Always-on rules (ponytail) for the current level, or '' when off. Every agent, sub-agents included, gets them. */
  prelude(): string
  sandbox: Sandbox
  cwd: string
  checkpoint(tool: string, files: string[]): Promise<string>
  /** The permission gate for one agent (it labels its approval requests with the agent's name; `key` identifies this run for the MCP suspicion flag). */
  authorize(agentName: string, key?: string): Authorizer
  emit(e: AgentEvent): void
  /** The provider's page can take image attachments (selectors `attach`). The `look` tool exists only when the configured vision provider can. */
  hasAttach?(provider: string): boolean
  /** MCP servers (outside programs). Absent = none. */
  mcp?: McpPool
  /** The private folder of one MCP program for one agent: the agent is told to save its files there. */
  mcpWorkDir?(server: string, agent: string): string
  /** Agents whose last MCP result read like orders: their next change or command must ask. Shared with the permission gate. */
  taint?: Set<string>
  /** Called once per message sent to a provider (usage counter). */
  onSend?(provider: string): void
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
}

const abortable =
  (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true })
    })

const clock = (until: number): string => new Date(until).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })

export class Orchestrator {
  private seq = 0
  /** Waiting notes for an agent ("server busy, queued"), delivered with its next MCP result and shown in the UI. */
  private readonly notes = new Map<string, string[]>()

  constructor(private readonly d: OrchestratorDeps) {}

  /** The MCP pool says an agent has to wait: show it now, tell the agent with its next result. */
  noteFor(agent: string, text: string): void {
    this.notes.set(agent, [...(this.notes.get(agent) ?? []), text])
    this.d.emit({ type: 'status', text, ...(agent === 'main' ? {} : { agent }) })
  }

  /** The two MCP tools for one agent, and what its first message says about the servers. */
  private mcpFor(key: string, servers: string[]): { tools: ToolDef[]; briefs: McpBrief[] } {
    const pool = this.d.mcp
    const usable = pool ? servers.filter((s) => pool.config(s)) : []
    if (!pool || !usable.length) return { tools: [], briefs: [] }
    const warn = (): void => {
      this.d.taint?.add(key)
      this.d.emit({ type: 'status', text: 'WARNING: an MCP result read like instructions. It was not followed, and the next change or command will ask you first.', ...(key === 'main' ? {} : { agent: key }) })
    }
    const tools = makeMcpTools({ api: pool, agent: key, servers: usable, onFlag: warn, takeNotes: () => this.notes.get(key)?.splice(0) ?? [] })
    return { tools, briefs: usable.map((name) => ({ name, description: pool.config(name)?.description, ...pool.knownTools(name) })) }
  }

  /** Runs the main agent on an adapter the caller already made (its window is the one the user watches). */
  async runMain(o: { provider: string; model?: string; task: string; images?: string[]; resume?: boolean; adapter: ProviderAdapter; signal: AbortSignal }): Promise<AgentReport> {
    const { d } = this
    const agent = (status: 'queued' | 'running' | 'done' | 'error' | 'stopped', note?: string): void =>
      d.emit({ type: 'agent', id: 'main', name: 'main', provider: o.provider, status, ...(note ? { note } : {}) })
    const fail = (summary: string, errorKind?: string): AgentReport => {
      const r: AgentReport = { reason: 'error', summary, steps: 0, ...(errorKind ? { errorKind } : {}) }
      d.emit({ type: 'error', kind: errorKind ?? 'internal', message: summary })
      d.emit({ type: 'finished', report: r })
      agent('error', summary)
      return r
    }
    const until = d.scheduler.limitedUntil(o.provider)
    if (until) return fail(`${o.provider} said "limit reached"; it is left alone until ${clock(until)}. Pick another provider or wait.`, 'rate_limit')
    agent('queued')
    let release: () => void
    try {
      release = await d.scheduler.acquire(o.provider, o.signal)
    } catch {
      agent('stopped')
      const r: AgentReport = { reason: 'aborted', summary: 'Stopped by the user.', steps: 0 }
      d.emit({ type: 'finished', report: r })
      return r
    }
    agent('running')
    try {
      const mainServers = d.mcp ? d.mcp.serverNames().filter((n) => d.mcp!.config(n)?.freeagent.mainAccess !== false) : []
      const mcp = this.mcpFor('main', mainServers)
      const look = this.lookTool(o.signal, true)
      const tools = [...d.tools, ...(d.skills.length ? [loadSkillTool(d.skills)] : []), ...mcp.tools, ...(look ? [look] : []), ...(d.config.agents.length ? [this.delegateTool(o.signal)] : [])]
      const report = await runAgent({
        adapter: counted(o.adapter, () => d.onSend?.(o.provider)),
        tools, task: o.task, images: o.images, resume: o.resume, cwd: d.cwd, authorize: d.authorize('main', 'main'), sandbox: d.sandbox,
        checkpoint: d.checkpoint, model: o.model, signal: o.signal, emit: d.emit, skills: d.skills, prelude: d.prelude(), mcp: mcp.briefs
      })
      if (report.errorKind === 'rate_limit') d.scheduler.markLimited(o.provider)
      agent(report.reason === 'finish' ? 'done' : report.reason === 'aborted' ? 'stopped' : 'error', report.summary.slice(0, 200))
      return report
    } finally {
      release()
      d.taint?.delete('main')
      await d.mcp?.releaseAgent('main')
    }
  }

  /** `look`: shows images to the configured vision chat. Absent when no vision is configured or its provider cannot take images. */
  private lookTool(signal: AbortSignal, announce = false): ToolDef | undefined {
    const { d } = this
    const v = d.config.vision
    if (!v) return undefined
    if (!d.isReady(v.provider) || d.hasAttach?.(v.provider) === false) {
      if (announce) d.emit({ type: 'status', text: `look is off: ${v.provider} cannot take images yet (it needs "attach" selectors)` })
      return undefined
    }
    let used = 0 // per agent run: this tool object is built once for each run
    return makeLookTool((images, prompt, sig) => {
      if (++used > v.maxCalls) {
        throw new Error(`look budget used up (${v.maxCalls} calls in this run, each one is a chat message on a free account): stop polishing, finish, and say in your report what was not checked`)
      }
      return this.look(images, prompt, sig ?? signal)
    })
  }

  /** One question about some images, asked in a fresh chat of the vision provider (so it never mixes with any agent's conversation). */
  private async look(images: string[], prompt: string, signal: AbortSignal): Promise<string> {
    const { d } = this
    const v = d.config.vision!
    const until = d.scheduler.limitedUntil(v.provider)
    if (until) throw new Error(`the vision chat (${v.provider}) said "limit reached" and rests until ${clock(until)}: verify by other means`)
    let release: () => void
    try {
      release = await d.scheduler.acquire(v.provider, signal)
    } catch {
      throw new Error('stopped by the user')
    }
    const session = d.makeSession(v.provider, `look-${++this.seq}`)
    try {
      const adapter = counted(session.adapter, () => d.onSend?.(v.provider))
      await adapter.newChat()
      if (v.model && v.model !== 'default') await adapter.selectModel(v.model).catch(() => undefined) // the page's own model still sees
      for (let attempt = 0; ; attempt++) {
        try {
          await adapter.send(prompt, images)
          let text = ''
          for await (const s of adapter.stream(signal)) text = s.text
          return text
        } catch (e) {
          if (e instanceof ProviderError && e.kind === 'rate_limit') d.scheduler.markLimited(v.provider)
          // the site dropped the message or gave up mid-answer: once more in the same chat
          if (!(e instanceof ProviderError) || e.kind !== 'interrupted' || attempt >= 1) throw e
          await (d.sleep ?? abortable)(3000, signal)
        }
      }
    } finally {
      session.dispose()
      release()
    }
  }

  private delegateTool(signal: AbortSignal): ToolDef<{ agent: string; task: string }> {
    const { agents } = this.d.config
    const names = agents.map((a) => a.name)
    return {
      name: 'delegate',
      description:
        'Hand a self-contained task to a sub-agent that works in its own chat and answers with a short report. Several delegate blocks in one reply run in parallel. Agents: ' +
        agents.map((a) => `${a.name} (${a.description})`).join('; '),
      argsHint: '{"agent": string, "task": string}',
      schema: z.object({
        agent: z.string().refine((n) => names.includes(n), { message: `unknown agent, use one of: ${names.join(', ')}` }),
        task: z.string().min(1).max(10_000)
      }),
      risk: 'read',
      parallel: true,
      run: async (a, ctx) => this.delegate(agents.find((x) => x.name === a.agent)!, a.task, ctx.signal ?? signal)
    }
  }

  private async delegate(def: AgentDef, task: string, signal: AbortSignal): Promise<string> {
    const { d } = this
    const id = `${def.name}-${++this.seq}`
    const status = (provider: string, s: 'queued' | 'running' | 'done' | 'error' | 'stopped', note?: string): void =>
      d.emit({ type: 'agent', id, name: def.name, provider, status: s, ...(note ? { note } : {}) })
    const sleep = d.sleep ?? abortable

    const candidates = [def.provider, ...def.fallback].filter((p, i, all) => all.indexOf(p) === i && d.isReady(p))
    if (!candidates.length) {
      status(def.provider, 'error', 'no ready provider')
      throw new Error(`no ready provider for "${def.name}" (tried ${[def.provider, ...def.fallback].join(', ')}): capture its selectors with npm run inspect -- <provider>`)
    }
    status(candidates[0]!, 'queued')

    const subSkills = d.skills.filter((s) => def.skills.includes(s.name))
    const mcp = this.mcpFor(id, def.mcp)
    const look = def.tools.includes('look') ? this.lookTool(signal) : undefined
    const tools = [...def.tools.flatMap((n) => d.tools.filter((t) => t.name === n && t.name !== 'delegate')), ...(subSkills.length ? [loadSkillTool(subSkills)] : []), ...mcp.tools, ...(look ? [look] : [])]
    const folders = mcp.briefs.map((b) => `- ${b.name}: ${d.mcpWorkDir?.(b.name, id) ?? '(none)'}`)
    const role = `${def.name}: ${def.description}${folders.length ? `\nMCP working folders (each MCP program of yours runs inside its own folder: save your files there):\n${folders.join('\n')}` : ''}`
    const tried: string[] = []
    for (;;) {
      // Prefer a provider that is not resting; if all rest, wait for the soonest (up to the configured cap).
      let pick = candidates.find((p) => !tried.includes(p) && !d.scheduler.limitedUntil(p))
      if (!pick) {
        const open = candidates.filter((p) => !tried.includes(p))
        const soonest = Math.min(...open.map((p) => d.scheduler.limitedUntil(p) ?? Infinity))
        if (!open.length || !Number.isFinite(soonest) || soonest - Date.now() > d.config.limits.maxWaitMs) {
          status(def.provider, 'error', 'all providers rate-limited')
          throw new Error(`"${def.name}" could not run: ${tried.length ? `${tried.join(', ')} hit their limit` : 'its providers are rate-limited'}${Number.isFinite(soonest) ? `, the next one frees up at ${clock(soonest)}` : ''}`)
        }
        status(open[0]!, 'queued', `waiting for the rate limit (until ${clock(soonest)})`)
        await sleep(Math.max(0, soonest - Date.now()), signal)
        pick = open.find((p) => !d.scheduler.limitedUntil(p)) ?? open[0]!
      }
      tried.push(pick)

      let release: () => void
      try {
        release = await d.scheduler.acquire(pick, signal)
      } catch {
        status(pick, 'stopped')
        throw new Error('stopped by the user')
      }
      status(pick, 'running')
      const session = d.makeSession(pick, id)
      let report: AgentReport
      try {
        report = await runAgent({
          adapter: counted(session.adapter, () => d.onSend?.(pick)),
          tools, task, cwd: d.cwd, authorize: d.authorize(def.name, id), sandbox: d.sandbox, checkpoint: d.checkpoint,
          model: def.model, maxSteps: def.maxSteps, role, signal, skills: subSkills, prelude: d.prelude(), mcp: mcp.briefs,
          // A sub-agent's "finished" is NOT the task's end: the UI must not stop the main run because of it.
          emit: (e) => { if (e.type !== 'finished') d.emit({ ...e, agent: id }) }
        })
      } finally {
        session.dispose()
        release()
        d.taint?.delete(id)
        await d.mcp?.releaseAgent(id) // its MCP process (a Blender) goes with it, success or not
      }
      if (report.errorKind === 'rate_limit') {
        d.scheduler.markLimited(pick)
        if (candidates.some((p) => !tried.includes(p))) {
          status(pick, 'error', 'rate limit: trying the next provider')
          continue
        }
      }
      const s = report.reason === 'finish' ? 'done' : report.reason === 'aborted' ? 'stopped' : 'error'
      status(pick, s, report.summary.slice(0, 200))
      if (report.reason === 'finish') return `[${def.name} on ${pick}] done in ${report.steps} steps\n${report.summary}`
      throw new Error(`[${def.name} on ${pick}] ${report.reason} after ${report.steps} steps: ${report.summary}`)
    }
  }
}
