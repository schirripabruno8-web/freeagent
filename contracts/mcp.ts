import { z } from 'zod'

/** One entry of config/mcp.json. `command`/`args`/`env`/`url`/`type` follow .mcp.json; everything FreeAgent adds lives under `freeagent`. */
const Launch = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  /** Regex with ONE capture group, matched on the process output. When it appears the instance is ready; the group becomes {ready}. */
  ready: z.string().optional(),
  /** "pick": the app chooses a free port and passes it as {port}. Default: the process reports its own (see `ready`). */
  portStrategy: z.enum(['report', 'pick']).default('report'),
  startTimeoutMs: z.number().int().min(1000).default(60_000)
})

const Call = z.object({ tool: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) })

export const McpExtrasSchema = z
  .object({
    /** shared: parallel calls. serialized: one call at a time. lease: one AGENT at a time, for its whole job. instance-per-agent: a server process per agent. */
    concurrency: z.enum(['shared', 'serialized', 'lease', 'instance-per-agent']).default('lease'),
    /** instance-per-agent: how many processes at once (RAM). The rest queue. */
    maxInstances: z.number().int().min(1).max(32).default(4),
    /** instance-per-agent: do not start a new process while less than this much RAM is free (the first one always starts). */
    minFreeMemMB: z.number().int().min(0).default(1500),
    queueTimeoutMs: z.number().int().min(1000).default(300_000),
    /** lease: a holder that makes no call for this long loses the server. */
    leaseIdleMs: z.number().int().min(1000).default(60_000),
    callTimeoutMs: z.number().int().min(1000).default(120_000),
    /** Only these tools reach the agents (`*` wildcard). Default: all. Use it to switch off third-party tools you do not want used. */
    allowTools: z.array(z.string()).optional(),
    denyTools: z.array(z.string()).default([]),
    /** Tools that only read: they follow the read rule of the permission mode instead of the write rule. */
    readOnlyTools: z.array(z.string()).default([]),
    /** true: use `launch`. false: use `launchUi` (a window you can watch). */
    headless: z.boolean().default(true),
    launch: Launch.optional(),
    launchUi: Launch.optional(),
    /** Tool calls made right after connecting (e.g. load a skill). */
    initCalls: z.array(Call).default([]),
    health: Call.optional(),
    /** Called (best effort) before the process is killed. */
    closeCall: Call.optional(),
    /** Whether the main agent may use this server (sub-agents need it listed in their `mcp`). */
    mainAccess: z.boolean().default(true)
  })
  .prefault({}) // zod 4: a plain default() would skip the inner defaults
export type McpExtras = z.infer<typeof McpExtrasSchema>

export const McpServerSchema = z.object({
  type: z.enum(['stdio', 'http']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().optional(),
  description: z.string().max(300).optional(),
  freeagent: McpExtrasSchema
})
export type McpServerConfig = z.infer<typeof McpServerSchema>

export const McpConfigSchema = z.object({ mcpServers: z.record(z.string(), McpServerSchema).default({}) })

export interface McpInstanceStatus {
  agent: string
  state: 'starting' | 'ready' | 'closing'
  pid?: number
}

/** What the pool knows about a server that is configured and switched on. */
export interface McpRuntimeStatus {
  name: string
  description?: string
  mode: McpExtras['concurrency']
  instances: McpInstanceStatus[]
  /** Agents waiting for the server (queue or free slot). */
  queued: number
  /** lease mode: who holds the server. */
  holder?: string
  /** Tool names agents can see (after allow/deny), once known. */
  tools?: string[]
}

/** What the panel shows: the runtime status plus where the server comes from and whether it is on. */
export interface McpServerStatus extends McpRuntimeStatus {
  /** Switched on = agents can see it. Off = still configured, never started, shown greyed out. */
  enabled: boolean
  /** `bundled` comes with the app (config/mcp.json); `user` was added from the app (mcp.user.json) and can be removed. */
  source: 'bundled' | 'user'
  /** What starts it, without any environment value (they may hold keys): "npx -y @scope/pkg" or the address. */
  summary: string
  /** A server on the network, not a program started here: what you send it leaves this PC. */
  remote: boolean
}

/** A server read from something the user pasted, ready to be added (the user sees it first). */
export interface McpCandidate {
  name: string
  config: { type: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string }
  /** Things the user should know ("headers are not supported yet"). */
  notes?: string[]
}

/** What the user chose to add (it comes from the UI, so it is checked again in the main process). `shared` only for servers that keep no state between calls; everything else queues one agent at a time. */
export const McpNewServerSchema = z.object({
  name: z.string().max(64),
  config: z.object({
    type: z.enum(['stdio', 'http']),
    command: z.string().max(1000).optional(),
    args: z.array(z.string().max(2000)).max(100).optional(),
    env: z.record(z.string().max(200), z.string().max(4000)).optional(),
    url: z.string().max(2000).optional()
  }),
  description: z.string().max(300).optional(),
  mainAccess: z.boolean().optional(),
  concurrency: z.enum(['lease', 'shared']).optional()
})
export type McpNewServer = z.infer<typeof McpNewServerSchema>

export type McpProbeResult = { ok: true; tools: string[] } | { ok: false; error: string }

export interface McpListing {
  servers: McpServerStatus[]
  /** Servers that could not be loaded, and why. */
  problems: string[]
  /** Where the servers added from the app are saved (editable by hand). */
  userFile: string
}
