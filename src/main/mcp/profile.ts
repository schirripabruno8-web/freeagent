import { readFileSync } from 'node:fs'
import { McpServerSchema, type McpServerConfig } from '@contracts/mcp'

export interface McpServers {
  servers: Map<string, McpServerConfig>
  problems: string[]
}

/**
 * Reads config/mcp.json (the `mcpServers` map of .mcp.json plus our `freeagent` extras). Each server is checked alone:
 * one typo drops that server and says why. Names are lowercase so the model can type them.
 */
export function loadMcpConfig(file: string): McpServers {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`)
  }
  const map = ((raw as { mcpServers?: unknown } | null)?.mcpServers ?? {}) as Record<string, unknown>
  if (typeof map !== 'object' || Array.isArray(map)) throw new Error(`${file}: "mcpServers" must be an object`)
  return parseServers(map)
}

/** The checks of one `mcpServers` map (a file's, or what the app is about to write): each server is judged alone. */
export function parseServers(map: Record<string, unknown>): McpServers {
  const servers = new Map<string, McpServerConfig>()
  const problems: string[] = []
  for (const [name, row] of Object.entries(map)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
      problems.push(`server "${name}": the name must be lowercase letters, digits, - and _`)
      continue
    }
    const r = McpServerSchema.safeParse(row)
    if (!r.success) {
      problems.push(`server "${name}": ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
      continue
    }
    const c = r.data
    const x = c.freeagent
    if (!c.command && !c.url) problems.push(`server "${name}": needs a "command" (stdio) or a "url" (http)`)
    else if (x.concurrency === 'instance-per-agent' && !x.launch && !x.launchUi && !c.command) {
      problems.push(`server "${name}": instance-per-agent with only a "url" needs a "launch" to start one instance per agent`)
    } else servers.set(name, c)
  }
  return { servers, problems }
}

/** `*` wildcard only. */
export function matchTool(pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(name)
}

/** Deny wins, then the allowlist (absent = everything). This is how third-party tools are switched off. */
export function toolAllowed(cfg: McpServerConfig, name: string): boolean {
  const x = cfg.freeagent
  if (x.denyTools.some((p) => matchTool(p, name))) return false
  return !x.allowTools || x.allowTools.some((p) => matchTool(p, name))
}

export const toolReadOnly = (cfg: McpServerConfig, name: string): boolean => cfg.freeagent.readOnlyTools.some((p) => matchTool(p, name))

const KNOWN = ['port', 'ready', 'agentDir', 'blenderExe', 'agent', 'server']

/** `%VAR%` from the environment and `{port}`, `{ready}`, `{agentDir}`, `{blenderExe}`, `{agent}`, `{server}`. Other braces stay as they are. */
export function expandVars(s: string, vars: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string {
  return s
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n: string) => env[n] ?? m)
    .replace(/\{([A-Za-z]+)\}/g, (m, n: string) => (KNOWN.includes(n) ? (vars[n] ?? m) : m))
}
