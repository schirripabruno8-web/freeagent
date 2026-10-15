import { z } from 'zod'

/**
 * One row of config/models.json, edited by hand. Nothing in the app's logic depends on a model name: this is data.
 * `id` is what the page's own model picker calls it (so adapter.selectModel(id) works); "default" means "whatever the page uses now".
 */
export const ModelEntrySchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  label: z.string().min(1),
  capabilities: z.array(z.enum(['code', 'reasoning', 'long-context', 'tools', 'vision'])).default([]),
  /** How well it follows the text command protocol. "unknown" until someone has tried it. */
  toolReliability: z.enum(['good', 'fair', 'poor', 'unknown']).default('unknown'),
  limits: z.string().optional(),
  notes: z.string().optional()
})
export type ModelEntry = z.infer<typeof ModelEntrySchema>

/** Messages the app sent to a provider. A hint for the free-tier limits, not an accurate meter. */
export interface UsageInfo {
  today: number
  week: number
}
