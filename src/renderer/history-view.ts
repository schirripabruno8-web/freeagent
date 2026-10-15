import type { HistoryMeta } from '@contracts/history'

export type Group = { label: string; items: HistoryMeta[] }

const DAY = 24 * 3600 * 1000

const startOfDay = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Today / yesterday / this week / older, most recent first inside each group. Empty groups are left out. */
export function groupByDay(list: HistoryMeta[], now = Date.now()): Group[] {
  const today = startOfDay(now)
  const buckets: Group[] = [
    { label: 'Oggi', items: [] },
    { label: 'Ieri', items: [] },
    { label: 'Ultimi 7 giorni', items: [] },
    { label: 'Più vecchie', items: [] }
  ]
  for (const m of list.toSorted((a, b) => b.updatedAt - a.updatedAt)) {
    const t = startOfDay(m.updatedAt)
    const i = t >= today ? 0 : t >= today - DAY ? 1 : t >= today - 6 * DAY ? 2 : 3
    buckets[i]!.items.push(m)
  }
  return buckets.filter((g) => g.items.length > 0)
}

/** "adesso", "5 min fa", "oggi 20:10", "ieri 20:10", "12 ott". */
export function whenLabel(t: number, now = Date.now()): string {
  const min = Math.floor((now - t) / 60_000)
  if (min < 1) return 'adesso'
  if (min < 60) return `${min} min fa`
  const hm = new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
  const days = (startOfDay(now) - startOfDay(t)) / DAY
  if (days < 1) return `oggi ${hm}`
  if (days < 2) return `ieri ${hm}`
  return new Date(t).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
}

export const matches = (m: HistoryMeta, q: string): boolean => {
  const s = q.trim().toLowerCase()
  return !s || [m.title, m.summary, m.cwd, m.provider].some((x) => x.toLowerCase().includes(s))
}
