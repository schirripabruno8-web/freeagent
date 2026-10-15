import { z } from 'zod'

/** One sub-agent the main agent can delegate to. Lives in config/agents.json; with none defined, the `delegate` tool does not exist. */
export const AgentDefSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'lowercase letters, digits, - and _'),
  /** Shown to the main agent so it knows when to delegate. */
  description: z.string().min(1).max(300),
  provider: z.string().min(1),
  /** Model id on the provider's page; "default" or unset = leave the page as it is. */
  model: z.string().optional(),
  /** Providers to try, in order, if `provider` is rate-limited or not ready. */
  fallback: z.array(z.string()).default([]),
  /** Tool names from the registry. A sub-agent never gets `delegate`: no recursion. */
  tools: z.array(z.string()).default(['read', 'glob', 'grep']),
  /** MCP servers it may use (Phase 4). */
  mcp: z.array(z.string()).default([]),
  /** Skills it may load (Phase 5). */
  skills: z.array(z.string()).default([]),
  maxSteps: z.number().int().min(1).max(100).default(20)
})
export type AgentDef = z.infer<typeof AgentDefSchema>

export const LimitsSchema = z
  .object({
    /** Chats the app drives at once on one provider. */
    default: z.number().int().min(1).max(4),
    perProvider: z.record(z.string(), z.number().int().min(1).max(4)),
    /** Minimum gap between two chat starts on the same provider. */
    cooldownMs: z.number().int().min(0),
    /** After a "limit reached" message the provider is left alone this long. */
    rateLimitBackoffMs: z.number().int().min(1000),
    /** How long a delegation waits for a limited provider before giving up. */
    maxWaitMs: z.number().int().min(0)
  })
  .partial()
  .transform((l) => ({
    default: l.default ?? 2,
    perProvider: l.perProvider ?? {},
    cooldownMs: l.cooldownMs ?? 1500,
    rateLimitBackoffMs: l.rateLimitBackoffMs ?? 10 * 60_000,
    maxWaitMs: l.maxWaitMs ?? 2 * 60_000
  }))
export type Limits = z.infer<typeof LimitsSchema>

/** The chat that gets to SEE images for the `look` tool (it needs `attach` selectors: today only Qwen has them). Absent = no `look` tool. */
export const VisionSchema = z.object({
  provider: z.string().min(1),
  /** Model id on the provider's page; unset = leave the page as it is. */
  model: z.string().optional(),
  /** Most look calls ONE agent run may make (each costs a chat message on a free account): after that look says so and the agent must wrap up. */
  maxCalls: z.number().int().min(1).max(50).default(10)
})
export type Vision = z.infer<typeof VisionSchema>

export const AgentsConfigSchema = z.object({
  limits: LimitsSchema.default({} as never),
  agents: z.array(AgentDefSchema).default([]),
  vision: VisionSchema.optional()
})
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>
