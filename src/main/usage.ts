import { readFileSync, writeFileSync } from 'node:fs'
import type { UsageInfo } from '@contracts/models'
import type { ProviderAdapter } from '@contracts/provider'

type Data = Record<string, Record<string, number>> // provider -> local day -> messages sent

const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const KEEP_DAYS = 14

/** Messages the app sent per provider and day, kept in a small JSON file. A hint for the free-tier limits, not an exact meter. */
export class Usage {
  private data: Data

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date()
  ) {
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8')) as Data
    } catch {
      this.data = {}
    }
  }

  record(provider: string): void {
    const today = dayKey(this.now())
    const days = (this.data[provider] ??= {})
    days[today] = (days[today] ?? 0) + 1
    const cutoff = dayKey(new Date(this.now().getTime() - KEEP_DAYS * 24 * 3600 * 1000))
    for (const k of Object.keys(days)) if (k < cutoff) delete days[k]
    try {
      writeFileSync(this.file, JSON.stringify(this.data))
    } catch {
      /* the counter is a convenience: never break a task over it */
    }
  }

  summary(): Record<string, UsageInfo> {
    const now = this.now().getTime()
    const last7 = new Set(Array.from({ length: 7 }, (_, i) => dayKey(new Date(now - i * 24 * 3600 * 1000))))
    const today = dayKey(this.now())
    const out: Record<string, UsageInfo> = {}
    for (const [p, days] of Object.entries(this.data)) {
      out[p] = {
        today: days[today] ?? 0,
        week: Object.entries(days).reduce((n, [k, v]) => n + (last7.has(k) ? v : 0), 0)
      }
    }
    return out
  }
}

/** The adapter, counting every message it successfully sends. */
export function counted(adapter: ProviderAdapter, onSend: () => void): ProviderAdapter {
  return {
    ...adapter,
    send: async (text, images) => {
      await adapter.send(text, images)
      onSend()
    }
  }
}
