import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { AgentEvent } from '@contracts/agent'
import { HistoryMetaSchema, type HistoryEntry, type HistoryMeta } from '@contracts/history'

const MAX_TEXT = 12_000 // one reply or tool output
const MAX_STR = 4_000 // one string inside tool arguments (a whole file written by `write`)
const MAX_EVENTS = 3_000

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}… [${s.length - max} caratteri in meno nella cronologia]` : s)

const shrink = (v: unknown): unknown => {
  if (typeof v === 'string') return cut(v, MAX_STR)
  if (Array.isArray(v)) return v.map(shrink)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]))
  return v
}

/** What is worth keeping of an event (long texts cut, nothing else changed). */
export function compact(e: AgentEvent): AgentEvent {
  switch (e.type) {
    case 'assistant':
      return { ...e, text: cut(e.text, MAX_TEXT) }
    case 'tool_result':
      return { ...e, output: cut(e.output, MAX_TEXT) }
    case 'tool_call':
      return { ...e, call: { ...e.call, args: shrink(e.call.args) as typeof e.call.args } }
    case 'user':
      return { ...e, text: cut(e.text, MAX_TEXT) }
    default:
      return e
  }
}

/**
 * Collects the events of ONE run. Streaming snapshots of a reply replace each other (like the log does), otherwise a long reply
 * would be kept hundreds of times; everything else is stored once, compacted.
 */
export class Recorder {
  readonly events: AgentEvent[] = []

  push(e: AgentEvent): void {
    if (e.type === 'reminder' || e.type === 'agent') return // the log does not show them either
    if (e.type === 'assistant') {
      // a reply in progress (and its final version) is ONE entry: each snapshot replaces the previous one
      const i = this.events.findLastIndex((x) => x.type === 'assistant' && !x.done && x.agent === e.agent)
      if (i >= 0) {
        this.events[i] = compact(e)
        return
      }
    }
    this.events.push(compact(e))
  }
}

/** The page of a chat on its provider (not the provider's home, not the transient new-chat page); undefined if `url` is not one. */
export function chatUrlOf(url: string, homeUrl: string): string | undefined {
  try {
    const u = new URL(url)
    const home = new URL(homeUrl)
    if (u.protocol !== 'https:' || u.hostname !== home.hostname) return undefined
    if (u.pathname.length <= 1 || /new-chat/i.test(u.pathname)) return undefined
    return u.href
  } catch {
    return undefined
  }
}

const IndexSchema = z.array(HistoryMetaSchema)
const idOk = (id: string): boolean => HistoryMetaSchema.shape.id.safeParse(id).success

export interface RunRecord {
  provider: string
  model?: string
  cwd: string
  /** What the user asked in this run. */
  task: string
  chatUrl?: string
  status: HistoryMeta['status']
  summary: string
  startedAt: number
  events: AgentEvent[]
}

/**
 * Past chats on disk: `index.json` (the list) + `<id>.json` (the events of each). A run that ends in a chat already in the list
 * (same provider, same chat page) is appended to it: "Continua" extends a chat instead of creating a new entry.
 */
export class HistoryStore {
  constructor(
    private readonly dir: string,
    private readonly max = 100
  ) {}

  private write(file: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file) // never leaves a half-written file behind
  }

  private readIndex(): HistoryMeta[] {
    try {
      const parsed = IndexSchema.safeParse(JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')))
      return parsed.success ? parsed.data : []
    } catch {
      return [] // no file yet, or unreadable: the history is a convenience, never a reason to fail a task
    }
  }

  list(): HistoryMeta[] {
    return this.readIndex().toSorted((a, b) => b.updatedAt - a.updatedAt)
  }

  load(id: string): HistoryEntry | undefined {
    if (!idOk(id)) return undefined
    const meta = this.readIndex().find((m) => m.id === id)
    if (!meta) return undefined
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8'))
      const events = Array.isArray(raw) ? raw.filter((e): e is AgentEvent => !!e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string') : []
      return { meta, events }
    } catch {
      return { meta, events: [] }
    }
  }

  record(r: RunRecord): HistoryMeta {
    const index = this.readIndex()
    const now = Date.now()
    const same = r.chatUrl ? index.find((m) => m.provider === r.provider && m.chatUrl === r.chatUrl) : undefined
    const prev = same ? (this.load(same.id)?.events ?? []) : []
    const events = [...prev, ...r.events].slice(-MAX_EVENTS)
    const meta: HistoryMeta = {
      id: same?.id ?? `${now.toString(36)}-${randomBytes(3).toString('hex')}`,
      provider: r.provider,
      ...(r.model ? { model: r.model } : {}),
      cwd: r.cwd,
      title: same?.title ?? (r.task.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Chat'),
      startedAt: same?.startedAt ?? r.startedAt,
      updatedAt: now,
      ...(r.chatUrl ? { chatUrl: r.chatUrl } : {}),
      status: r.status,
      summary: r.summary.slice(0, 400),
      runs: (same?.runs ?? 0) + 1
    }
    this.write(join(this.dir, `${meta.id}.json`), events)
    const rest = index.filter((m) => m.id !== meta.id)
    const kept = [meta, ...rest].toSorted((a, b) => b.updatedAt - a.updatedAt)
    for (const old of kept.slice(this.max)) rmSync(join(this.dir, `${old.id}.json`), { force: true })
    this.write(join(this.dir, 'index.json'), kept.slice(0, this.max))
    return meta
  }

  remove(id: string): void {
    if (!idOk(id)) return
    this.write(join(this.dir, 'index.json'), this.readIndex().filter((m) => m.id !== id))
    rmSync(join(this.dir, `${id}.json`), { force: true })
  }
}
