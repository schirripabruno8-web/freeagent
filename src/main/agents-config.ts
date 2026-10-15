import { readFileSync } from 'node:fs'
import { AgentDefSchema, AgentsConfigSchema, VisionSchema, type AgentsConfig, type Vision } from '@contracts/agents'

/**
 * Reads config/agents.json. Limits come from the schema defaults; each agent is checked on its own so one typo
 * drops that agent (and says why) instead of disabling delegation altogether.
 */
export function loadAgentsConfig(file: string, toolNames: string[], providerIds: string[], skillNames: string[] = [], mcpNames: string[] = []): { config: AgentsConfig; problems: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`)
  }
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const limits = AgentsConfigSchema.shape.limits.safeParse(obj['limits'] ?? {})
  const problems: string[] = []
  if (!limits.success) problems.push(`limits: ${limits.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')} (defaults used)`)
  let vision: Vision | undefined
  if (obj['vision'] !== undefined) {
    const v = VisionSchema.safeParse(obj['vision'])
    if (!v.success) problems.push(`vision: ${v.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')} (no look tool)`)
    else if (!providerIds.includes(v.data.provider)) problems.push(`vision: unknown provider "${v.data.provider}" (available: ${providerIds.join(', ')}; no look tool)`)
    else vision = v.data
  }
  const agents = []
  const seen = new Set<string>()
  for (const row of Array.isArray(obj['agents']) ? obj['agents'] : []) {
    const r = AgentDefSchema.safeParse(row)
    const label = (row as { name?: unknown } | null)?.name ?? '?'
    if (!r.success) {
      problems.push(`agent "${String(label)}": ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
      continue
    }
    const a = r.data
    const badTool = a.tools.find((t) => !toolNames.includes(t) || t === 'delegate')
    const badProvider = [a.provider, ...a.fallback].find((p) => !providerIds.includes(p))
    const badSkill = a.skills.find((s) => !skillNames.includes(s))
    const badMcp = a.mcp.find((m) => !mcpNames.includes(m))
    if (seen.has(a.name)) problems.push(`agent "${a.name}": defined twice`)
    else if (badTool) problems.push(`agent "${a.name}": unknown tool "${badTool}" (available: ${toolNames.filter((t) => t !== 'delegate').join(', ')})`)
    else if (badMcp) problems.push(`agent "${a.name}": unknown MCP server "${badMcp}" (configured: ${mcpNames.join(', ') || 'none'})`)
    else if (badSkill) problems.push(`agent "${a.name}": unknown skill "${badSkill}" (installed: ${skillNames.join(', ') || 'none'})`)
    else if (badProvider) problems.push(`agent "${a.name}": unknown provider "${badProvider}" (available: ${providerIds.join(', ')})`)
    else {
      seen.add(a.name)
      agents.push(a)
    }
  }
  return { config: { limits: limits.success ? limits.data : AgentsConfigSchema.shape.limits.parse({}), agents, ...(vision ? { vision } : {}) }, problems }
}
