import { readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import type { McpInstanceStatus, McpRuntimeStatus, McpServerConfig } from '@contracts/mcp'
import { McpCallError, McpConnection, type McpTarget, type ToolInfo } from './connection'
import { expandVars, toolAllowed } from './profile'
import { startProcess, type PidRegistry, type Started } from './process'

export interface PoolDeps {
  servers: Map<string, McpServerConfig>
  /** Private folder for one (server, agent); the pool asks, the caller creates it. */
  workDir(server: string, agent: string): string
  registry?: PidRegistry
  /** Values for {placeholders} the config can use, e.g. { blenderExe }. */
  vars?: Record<string, string>
  freeMemMB?: () => number
  /** Said to the agent when it has to wait ("server busy, queued"); also shown in the UI. */
  onNote?(agent: string, text: string): void
  onChange?(): void
  env?: NodeJS.ProcessEnv
  sleep?: (ms: number) => Promise<void>
  /** Where the tool names seen so far are remembered between runs (the first prompt lists them before any server is running). */
  catalogFile?: string
}

interface Instance {
  conn: McpConnection
  started?: Started
  agent: string
  close(): Promise<void>
}

interface Waiter {
  agent: string
  /** Slot waiters are handed the promise of the instance started for them, so a failed start reaches them. */
  resolve(started?: Promise<Instance>): void
  reject(e: Error): void
  timer?: ReturnType<typeof setTimeout>
  onAbort?: () => void
  signal?: AbortSignal
}

interface Runtime {
  name: string
  cfg: McpServerConfig
  /** shared / serialized / lease: the one connection. */
  shared?: Promise<Instance>
  /** serialized: the end of the line of calls. */
  tail: Promise<unknown>
  waiting: number
  lease: { holder?: string; timer?: ReturnType<typeof setTimeout>; waiters: Waiter[] }
  instances: Map<string, { p: Promise<Instance>; state: McpInstanceStatus['state']; pid?: number }>
  slotWaiters: Waiter[]
  slotTimer?: ReturnType<typeof setTimeout>
  catalog?: string[]
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const BACKOFF = [500, 1500]

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })

const mapVals = (o: Record<string, string>, f: (s: string) => string): Record<string, string> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]))

export class McpPool {
  private readonly rts = new Map<string, Runtime>()
  private readonly saved: Record<string, string[]> = {}

  constructor(private readonly d: PoolDeps) {
    try {
      if (d.catalogFile) Object.assign(this.saved, JSON.parse(readFileSync(d.catalogFile, 'utf8')))
    } catch {
      /* first run */
    }
    for (const [name, cfg] of d.servers) {
      this.rts.set(name, { name, cfg, tail: Promise.resolve(), waiting: 0, lease: { waiters: [] }, instances: new Map(), slotWaiters: [], catalog: this.saved[name] })
    }
  }

  private rt(server: string): Runtime {
    const r = this.rts.get(server)
    if (!r) throw new McpCallError(`unknown MCP server "${server}". Available: ${[...this.rts.keys()].join(', ') || 'none'}`, false)
    return r
  }

  private changed(): void {
    this.d.onChange?.()
  }

  private note(agent: string, text: string): void {
    this.d.onNote?.(agent, text)
  }

  // ---- starting one instance ------------------------------------------------------------------------------------------------

  private async start(rt: Runtime, agent: string): Promise<Instance> {
    const { cfg, name } = rt
    const x = cfg.freeagent
    const dir = this.d.workDir(name, agent)
    const vars: Record<string, string> = { ...this.d.vars, agent, server: name, agentDir: dir }
    const ex = (s: string): string => expandVars(s, vars, this.d.env)
    const L = x.headless ? x.launch : (x.launchUi ?? x.launch)
    let started: Started | undefined
    try {
      if (L) {
        if (L.portStrategy === 'pick') vars['port'] = String(await freePort())
        const command = ex(L.command)
        if (!command || /\{blenderExe\}/.test(command)) throw new Error('Blender was not found on this PC: install it, or set FREEAGENT_BLENDER to the full path of blender.exe')
        started = startProcess({
          command,
          args: L.args.map(ex),
          env: mapVals(L.env, ex),
          cwd: L.cwd ? ex(L.cwd) : dir,
          ready: L.ready ? new RegExp(L.ready) : undefined,
          timeoutMs: L.startTimeoutMs,
          registry: this.d.registry,
          label: `${name}/${agent}`
        })
        vars['ready'] = await started.ready
        vars['port'] ??= vars['ready']
        const rtState = rt.instances.get(agent)
        if (rtState) rtState.pid = started.pid
      }
      let target: McpTarget
      if (cfg.url) {
        const url = ex(cfg.url)
        // A process WE started must listen on this machine only: refuse anything else it reports.
        if (L && !LOOPBACK.has(new URL(url).hostname)) throw new Error(`refusing to connect to a non-local address: ${url}`)
        target = { kind: 'http', url }
      } else {
        target = { kind: 'stdio', command: ex(cfg.command!), args: cfg.args.map(ex), env: mapVals(cfg.env, ex), cwd: dir }
      }
      const conn = await McpConnection.open(target)
      const closeCall = x.closeCall
      const inst: Instance = {
        conn,
        started,
        agent,
        close: async () => {
          if (closeCall) await conn.call(closeCall.tool, closeCall.arguments, { timeoutMs: 3000 }).catch(() => undefined)
          await conn.close()
          await started?.stop()
        }
      }
      try {
        for (const c of x.initCalls) await conn.call(c.tool, c.arguments, { timeoutMs: x.callTimeoutMs })
        if (x.health) await conn.call(x.health.tool, x.health.arguments, { timeoutMs: x.callTimeoutMs })
      } catch (e) {
        await inst.close()
        throw e
      }
      return inst
    } catch (e) {
      await started?.stop()
      const why = (e as Error).message
      throw new McpCallError(`MCP server "${name}" could not start: ${why}${started && !why.includes(started.tail()) ? `\n${started.tail()}` : ''}`, false)
    }
  }

  private shared(rt: Runtime): Promise<Instance> {
    if (!rt.shared) {
      rt.shared = this.start(rt, 'shared')
      rt.shared.catch(() => (rt.shared = undefined)) // a failed start must not stay cached
    }
    return rt.shared
  }

  private async dropShared(rt: Runtime): Promise<void> {
    const p = rt.shared
    rt.shared = undefined
    const inst = await p?.catch(() => undefined)
    await inst?.close().catch(() => undefined)
  }

  // ---- lease --------------------------------------------------------------------------------------------------------------------

  private touchLease(rt: Runtime): void {
    clearTimeout(rt.lease.timer)
    const holder = rt.lease.holder
    if (!holder) return
    rt.lease.timer = setTimeout(() => {
      this.note(holder, `server "${rt.name}" was released: you made no call for ${Math.round(rt.cfg.freeagent.leaseIdleMs / 1000)} s. The next call queues again and the scene may have changed.`)
      this.releaseLease(rt, holder)
    }, rt.cfg.freeagent.leaseIdleMs)
  }

  private releaseLease(rt: Runtime, agent: string): void {
    const l = rt.lease
    if (l.holder !== agent) return
    clearTimeout(l.timer)
    l.holder = undefined
    const next = l.waiters.shift()
    if (next) {
      clearTimeout(next.timer)
      if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
      l.holder = next.agent
      this.touchLease(rt)
      next.resolve()
    }
    this.changed()
  }

  private acquireLease(rt: Runtime, agent: string, signal?: AbortSignal): Promise<void> {
    const l = rt.lease
    if (l.holder === agent) return (this.touchLease(rt), Promise.resolve())
    if (!l.holder) {
      l.holder = agent
      this.touchLease(rt)
      this.changed()
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { agent, resolve: resolve as Waiter['resolve'], reject, signal }
      const drop = (): void => {
        clearTimeout(w.timer)
        const i = l.waiters.indexOf(w)
        if (i >= 0) l.waiters.splice(i, 1)
        this.changed()
      }
      w.timer = setTimeout(() => {
        drop()
        reject(new McpCallError(`server "${rt.name}" stayed busy for ${Math.round(rt.cfg.freeagent.queueTimeoutMs / 1000)} s (held by ${l.holder}). Try another approach or ask again later.`, false))
      }, rt.cfg.freeagent.queueTimeoutMs)
      w.onAbort = () => (drop(), reject(new McpCallError('stopped by the user', false)))
      signal?.addEventListener('abort', w.onAbort, { once: true })
      if (signal?.aborted) return w.onAbort()
      l.waiters.push(w)
      this.note(agent, `server "${rt.name}" is busy (held by ${l.holder}): your call is queued, position ${l.waiters.length}.`)
      this.changed()
    })
  }

  // ---- one process per agent ----------------------------------------------------------------------------------------------------

  private freeMem = (): number => this.d.freeMemMB?.() ?? Math.floor(os.freemem() / 1048576)

  private canStart(rt: Runtime): boolean {
    const n = rt.instances.size
    const x = rt.cfg.freeagent
    return n < x.maxInstances && (n === 0 || this.freeMem() >= x.minFreeMemMB)
  }

  private drainSlots(rt: Runtime): void {
    clearTimeout(rt.slotTimer)
    rt.slotTimer = undefined
    while (rt.slotWaiters.length && this.canStart(rt)) {
      const w = rt.slotWaiters.shift()!
      clearTimeout(w.timer)
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort)
      w.resolve(this.begin(rt, w.agent)) // the slot is reserved right now, so the next check counts it
    }
    // Waiting only for RAM: nothing will call us, so look again in a moment.
    if (rt.slotWaiters.length) rt.slotTimer = setTimeout(() => this.drainSlots(rt), 2000)
    this.changed()
  }

  private begin(rt: Runtime, agent: string): Promise<Instance> {
    const entry = { state: 'starting' as McpInstanceStatus['state'], pid: undefined as number | undefined, p: undefined as unknown as Promise<Instance> }
    entry.p = this.start(rt, agent).then(
      (i) => ((entry.state = 'ready'), (entry.pid = i.started?.pid), this.changed(), i),
      (e) => {
        rt.instances.delete(agent)
        this.drainSlots(rt)
        throw e
      }
    )
    entry.p.catch(() => undefined)
    rt.instances.set(agent, entry)
    this.changed()
    return entry.p
  }

  private async instanceFor(rt: Runtime, agent: string, signal?: AbortSignal): Promise<Instance> {
    const have = rt.instances.get(agent)
    if (have) return have.p
    if (!rt.slotWaiters.length && this.canStart(rt)) return this.begin(rt, agent)
    return new Promise<Instance>((resolve, reject) => {
      const w: Waiter = { agent, resolve: resolve as Waiter['resolve'], reject, signal }
      const drop = (): void => {
        clearTimeout(w.timer)
        const i = rt.slotWaiters.indexOf(w)
        if (i >= 0) rt.slotWaiters.splice(i, 1)
        this.changed()
      }
      w.timer = setTimeout(() => {
        drop()
        reject(new McpCallError(`no free "${rt.name}" slot after ${Math.round(rt.cfg.freeagent.queueTimeoutMs / 1000)} s (${rt.instances.size} running, max ${rt.cfg.freeagent.maxInstances}, ${this.freeMem()} MB RAM free).`, false))
      }, rt.cfg.freeagent.queueTimeoutMs)
      w.onAbort = () => (drop(), reject(new McpCallError('stopped by the user', false)))
      signal?.addEventListener('abort', w.onAbort, { once: true })
      if (signal?.aborted) return w.onAbort()
      rt.slotWaiters.push(w)
      this.note(agent, `"${rt.name}": ${rt.instances.size} of ${rt.cfg.freeagent.maxInstances} instances are running or RAM is low (${this.freeMem()} MB free): your call is queued.`)
      this.drainSlots(rt)
    })
  }

  private async closeInstance(rt: Runtime, agent: string): Promise<void> {
    const e = rt.instances.get(agent)
    if (!e) return
    e.state = 'closing'
    this.changed()
    const inst = await e.p.catch(() => undefined)
    await inst?.close().catch(() => undefined)
    rt.instances.delete(agent)
    this.drainSlots(rt)
  }

  // ---- the one entry point ------------------------------------------------------------------------------------------------------

  private async run<T>(rt: Runtime, agent: string, fn: (c: McpConnection) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const mode = rt.cfg.freeagent.concurrency
    if (mode === 'instance-per-agent') return fn((await this.instanceFor(rt, agent, signal)).conn)
    if (mode === 'shared') return fn((await this.shared(rt)).conn)
    if (mode === 'lease') {
      await this.acquireLease(rt, agent, signal)
      try {
        return await fn((await this.shared(rt)).conn)
      } finally {
        this.touchLease(rt)
      }
    }
    // serialized: one call at a time, and a failed connection is retried with backoff
    const ahead = rt.waiting
    rt.waiting++
    if (ahead > 0) this.note(agent, `server "${rt.name}" is busy: your call is queued (${ahead} ahead).`)
    this.changed()
    const turn = rt.tail.then(async () => {
      if (signal?.aborted) throw new McpCallError('stopped by the user', false)
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn((await this.shared(rt)).conn)
        } catch (e) {
          if (!(e instanceof McpCallError) || !e.transient || attempt >= BACKOFF.length) throw e
          await this.dropShared(rt)
          await (this.d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(BACKOFF[attempt]!)
        }
      }
    })
    rt.tail = turn.catch(() => undefined)
    try {
      return (await turn) as T
    } finally {
      rt.waiting--
      this.changed()
    }
  }

  /** The tool names agents may use on this server. Starts the agent's instance (or takes the lease) if it must. */
  async tools(server: string, agent: string, signal?: AbortSignal): Promise<ToolInfo[]> {
    const rt = this.rt(server)
    const all = await this.run(rt, agent, (c) => c.tools(), signal)
    const ok = all.filter((t) => toolAllowed(rt.cfg, t.name))
    rt.catalog = ok.map((t) => t.name)
    this.saved[server] = rt.catalog
    try {
      if (this.d.catalogFile) writeFileSync(this.d.catalogFile, JSON.stringify(this.saved))
    } catch {
      /* a convenience only */
    }
    this.changed()
    return ok
  }

  /** What to tell the model about a server before any of it is running. */
  knownTools(server: string): { names?: string[]; patterns?: string[] } {
    const rt = this.rts.get(server)
    return { names: rt?.catalog, patterns: rt?.cfg.freeagent.allowTools }
  }

  async call(server: string, agent: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const rt = this.rt(server)
    if (!toolAllowed(rt.cfg, tool)) {
      const k = this.knownTools(server)
      throw new McpCallError(`tool "${tool}" is not available on "${server}". ${k.names ? `Available: ${k.names.join(', ')}` : `Allowed: ${(k.patterns ?? ['all']).join(', ')}`}`, false)
    }
    return this.run(rt, agent, (c) => c.call(tool, args, { signal, timeoutMs: rt.cfg.freeagent.callTimeoutMs }), signal)
  }

  config(server: string): McpServerConfig | undefined {
    return this.rts.get(server)?.cfg
  }

  serverNames(): string[] {
    return [...this.rts.keys()]
  }

  /** An agent is done: its lease and its process go. */
  async releaseAgent(agent: string): Promise<void> {
    for (const rt of this.rts.values()) {
      this.releaseLease(rt, agent)
      for (const w of rt.slotWaiters.filter((x) => x.agent === agent)) {
        clearTimeout(w.timer)
        rt.slotWaiters.splice(rt.slotWaiters.indexOf(w), 1)
        w.reject(new McpCallError('the agent finished while waiting', false))
      }
      for (const w of rt.lease.waiters.filter((x) => x.agent === agent)) {
        clearTimeout(w.timer)
        rt.lease.waiters.splice(rt.lease.waiters.indexOf(w), 1)
        w.reject(new McpCallError('the agent finished while waiting', false))
      }
      await this.closeInstance(rt, agent)
    }
  }

  async restart(server: string): Promise<void> {
    const rt = this.rt(server)
    for (const w of [...rt.lease.waiters, ...rt.slotWaiters]) {
      clearTimeout(w.timer)
      w.reject(new McpCallError(`"${server}" was restarted`, false))
    }
    rt.lease.waiters = []
    rt.slotWaiters = []
    clearTimeout(rt.lease.timer)
    rt.lease.holder = undefined
    await this.dropShared(rt)
    await Promise.all([...rt.instances.keys()].map((a) => this.closeInstance(rt, a)))
    this.changed()
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.rts.keys()].map((n) => this.restart(n)))
  }

  status(): McpRuntimeStatus[] {
    return [...this.rts.values()].map((rt) => {
      const mode = rt.cfg.freeagent.concurrency
      const instances: McpInstanceStatus[] = [...rt.instances.entries()].map(([agent, e]) => ({ agent, state: e.state, ...(e.pid ? { pid: e.pid } : {}) }))
      return {
        name: rt.name,
        ...(rt.cfg.description ? { description: rt.cfg.description } : {}),
        mode,
        instances,
        queued: mode === 'instance-per-agent' ? rt.slotWaiters.length : mode === 'lease' ? rt.lease.waiters.length : rt.waiting > 1 ? rt.waiting - 1 : 0,
        ...(rt.lease.holder ? { holder: rt.lease.holder } : {}),
        ...(rt.catalog ? { tools: rt.catalog } : {})
      }
    })
  }
}
