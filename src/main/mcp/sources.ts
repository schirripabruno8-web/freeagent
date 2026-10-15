import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { McpNewServer, McpRuntimeStatus, McpServerConfig, McpServerStatus } from '@contracts/mcp'
import { loadMcpConfig, parseServers } from './profile'

export interface ConfiguredServer {
  name: string
  /** `bundled`: config/mcp.json, shipped with the app. `user`: mcp.user.json, added from the app. */
  source: 'bundled' | 'user'
  enabled: boolean
  config: McpServerConfig
}

export interface Sources {
  /** Every server that loaded, switched on or off. */
  all: ConfiguredServer[]
  /** Only the switched-on ones: this is what the pool gets. */
  servers: Map<string, McpServerConfig>
  problems: string[]
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * The servers of config/mcp.json (bundled) plus the ones the user added (mcp.user.json), minus the ones switched off.
 * A user server named like a bundled one is ignored (the bundled profile is tuned, it must not be shadowed by accident).
 */
export function loadSources(bundledFile: string, userFile: string, disabled: string[]): Sources {
  const all: ConfiguredServer[] = []
  const problems: string[] = []
  const add = (source: ConfiguredServer['source'], servers: Map<string, McpServerConfig>): void => {
    for (const [name, config] of servers) {
      if (all.some((s) => s.name === name)) problems.push(`mcp.user.json: server "${name}" ignored: config/mcp.json already has one with that name`)
      else all.push({ name, source, enabled: !disabled.includes(name), config })
    }
  }
  try {
    const b = loadMcpConfig(bundledFile)
    problems.push(...b.problems)
    add('bundled', b.servers)
  } catch (e) {
    problems.push((e as Error).message)
  }
  if (existsSync(userFile)) {
    try {
      const u = loadMcpConfig(userFile)
      problems.push(...u.problems.map((p) => `mcp.user.json: ${p}`))
      add('user', u.servers)
    } catch (e) {
      problems.push(`mcp.user.json: ${(e as Error).message}`)
    }
  }
  return { all, servers: new Map(all.filter((s) => s.enabled).map((s) => [s.name, s.config])), problems }
}

/** What starts a server, for display: no environment value (they may hold keys) and no query string or login in an address. */
export function summaryOf(c: McpServerConfig): string {
  // a url that is only `{ready}` (the program reports its own address) says nothing: show the program that is started
  const launch = c.freeagent.launch ?? c.freeagent.launchUi
  const start = c.command ? { command: c.command, args: c.args } : launch
  if (start) return [start.command, ...start.args].join(' ').slice(0, 160)
  try {
    const u = new URL(c.url ?? '')
    return `${u.origin}${u.pathname}`
  } catch {
    return c.url ?? ''
  }
}

/** A server on the network: what is sent to it leaves this PC. A program started here (even one that serves http) is not remote. */
export function isRemote(c: McpServerConfig): boolean {
  if (c.command || c.freeagent.launch || c.freeagent.launchUi) return false
  try {
    return !LOOPBACK.has(new URL(c.url ?? '').hostname)
  } catch {
    return false
  }
}

/** What the panel lists: every configured server; the pool's live state only for the ones that are on (a switched-off one is never started). */
export function describeServers(all: ConfiguredServer[], runtime: McpRuntimeStatus[]): McpServerStatus[] {
  const live = new Map(runtime.map((r) => [r.name, r]))
  return all.map((s) => ({
    name: s.name,
    ...(s.config.description ? { description: s.config.description } : {}),
    mode: s.config.freeagent.concurrency,
    instances: [],
    queued: 0,
    ...(s.enabled ? live.get(s.name) : {}),
    enabled: s.enabled,
    source: s.source,
    summary: summaryOf(s.config),
    remote: isRemote(s.config)
  }))
}

function readUserMap(userFile: string): Record<string, unknown> {
  if (!existsSync(userFile)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(userFile, 'utf8'))
  } catch (e) {
    // Never overwrite a file the user may have edited by hand and broken: say so and stop.
    throw new Error(`${userFile} is not valid JSON (${(e as Error).message}): fix or delete it first`)
  }
  const map = (raw as { mcpServers?: unknown } | null)?.mcpServers ?? {}
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`${userFile}: "mcpServers" must be an object`)
  return map as Record<string, unknown>
}

function writeUserMap(userFile: string, map: Record<string, unknown>): void {
  mkdirSync(path.dirname(userFile), { recursive: true })
  const tmp = `${userFile}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, JSON.stringify({ mcpServers: map }, null, 2))
  renameSync(tmp, userFile) // a crash never leaves half a file
}

/** What goes into the file for one new server: only what was chosen, plus the two FreeAgent choices. */
function toRaw(s: McpNewServer): Record<string, unknown> {
  const c = s.config
  const common = { ...(s.description ? { description: s.description.slice(0, 300) } : {}), freeagent: { concurrency: s.concurrency ?? 'lease', mainAccess: s.mainAccess ?? true } }
  if (c.type === 'http') return { type: 'http', url: c.url, ...common }
  return { type: 'stdio', command: c.command, args: c.args ?? [], ...(c.env && Object.keys(c.env).length ? { env: c.env } : {}), ...common }
}

/** Adds servers to mcp.user.json. Throws, writing nothing, if any of them is not valid. `taken` = names already in use (bundled and user). */
export function addUserServers(userFile: string, entries: McpNewServer[], taken: string[]): string[] {
  if (!entries.length) throw new Error('nothing to add')
  const existing = readUserMap(userFile)
  const batch: Record<string, unknown> = {}
  for (const e of entries) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(e.name)) throw new Error(`"${e.name}": the name must be lowercase letters, digits, - and _ (at most 32), starting with a letter`)
    if (taken.includes(e.name) || e.name in existing || e.name in batch) throw new Error(`there is already a server named "${e.name}"`)
    if (e.config.type === 'http') {
      let u: URL
      try {
        u = new URL(e.config.url ?? '')
      } catch {
        throw new Error(`"${e.name}": "${e.config.url ?? ''}" is not an address`)
      }
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new Error(`"${e.name}": plain http is only allowed for this PC (127.0.0.1); use https for anything else`)
    }
    const raw = toRaw(e)
    const check = parseServers({ [e.name]: raw })
    if (!check.servers.has(e.name)) throw new Error(check.problems[0] ?? `"${e.name}" is not a valid server`)
    batch[e.name] = raw
  }
  writeUserMap(userFile, { ...existing, ...batch })
  return Object.keys(batch)
}

/** Removes a server the user added. false = it was not in the file (a bundled server cannot be removed, only switched off). */
export function removeUserServer(userFile: string, name: string): boolean {
  const map = readUserMap(userFile)
  if (!(name in map)) return false
  delete map[name]
  writeUserMap(userFile, map)
  return true
}
