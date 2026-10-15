import { z } from 'zod'
import type { AgentEvent } from './agent'

/** One past chat: the conversation with the main agent on a provider, kept on this PC (task text, replies, tool calls; never cookies or tokens). */
export const HistoryMetaSchema = z.object({
  id: z.string().regex(/^[\w-]{1,64}$/),
  provider: z.string().min(1),
  model: z.string().optional(),
  cwd: z.string(),
  /** The first thing the user asked. */
  title: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
  /** The chat's page on the provider site: opening it again lets "Continua" go on in the very same chat. */
  chatUrl: z.string().optional(),
  status: z.enum(['done', 'error', 'stopped']),
  /** How the last run ended. */
  summary: z.string(),
  /** Runs merged into this chat (the first one plus every "Continua"). */
  runs: z.number().int().min(1)
})
export type HistoryMeta = z.infer<typeof HistoryMetaSchema>

export interface HistoryEntry {
  meta: HistoryMeta
  events: AgentEvent[]
}
