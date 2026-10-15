import type { McpProbeResult, McpServerConfig } from '@contracts/mcp'
import { McpPool, type PoolDeps } from './pool'

/**
 * Starts one server in a pool of its own, asks for its tools and shuts it down: "does this work?" without touching the
 * app's pool or any running task. The pool's own limits bound the time (60 s to connect, 60 s to list), so there is no timer here.
 */
export async function probeServer(name: string, cfg: McpServerConfig, deps: Pick<PoolDeps, 'workDir' | 'registry' | 'vars' | 'env'>): Promise<McpProbeResult> {
  const pool = new McpPool({ ...deps, servers: new Map([[name, cfg]]) })
  try {
    return { ok: true, tools: (await pool.tools(name, 'probe')).map((t) => t.name) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    await pool.shutdown()
  }
}
