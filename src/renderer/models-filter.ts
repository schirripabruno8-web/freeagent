import type { ModelEntry } from '@contracts/models'

const RANK: Record<ModelEntry['toolReliability'], number> = { good: 0, fair: 1, unknown: 2, poor: 3 }

/** Pure. Il sort e' stabile: a parita' di affidabilita' resta l'ordine del registro. */
export function filterModels(
  models: ModelEntry[],
  f: { provider: string; query: string; onlyReliable: boolean }
): ModelEntry[] {
  const q = f.query.trim().toLowerCase()
  return models
    .filter((m) => m.provider === f.provider)
    .filter((m) => !f.onlyReliable || m.toolReliability === 'good')
    .filter((m) => [m.label, m.id, m.notes ?? '', ...m.capabilities].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => RANK[a.toolReliability] - RANK[b.toolReliability])
}
