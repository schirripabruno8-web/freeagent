import type { Limits } from '@contracts/agents'

interface Waiter {
  resolve(release: () => void): void
  reject(e: Error): void
  signal?: AbortSignal
  onAbort?: () => void
}
interface State {
  active: number
  queue: Waiter[]
  /** Earliest time the next chat may start (cooldown after the previous start). */
  readyAt: number
  timer?: ReturnType<typeof setTimeout>
  limitedUntil?: number
}

/**
 * Keeps the app polite with free chat sites: at most N chats at once per provider, a gap between starts,
 * and a rest period after a "limit reached" message. First come, first served.
 */
export class Scheduler {
  private readonly states = new Map<string, State>()

  constructor(
    private readonly limits: Limits,
    private readonly now: () => number = () => Date.now()
  ) {}

  private st(p: string): State {
    let s = this.states.get(p)
    if (!s) this.states.set(p, (s = { active: 0, queue: [], readyAt: 0 }))
    return s
  }

  private cap(p: string): number {
    return this.limits.perProvider[p] ?? this.limits.default
  }

  /** Waits for a free slot. Resolves with a release function (idempotent). Rejects if `signal` aborts while waiting. */
  acquire(provider: string, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const s = this.st(provider)
      const w: Waiter = { resolve, reject, signal }
      w.onAbort = () => {
        const i = s.queue.indexOf(w)
        if (i >= 0) s.queue.splice(i, 1)
        reject(new Error('aborted'))
      }
      signal?.addEventListener('abort', w.onAbort, { once: true })
      s.queue.push(w)
      this.drain(provider)
    })
  }

  private drain(p: string): void {
    const s = this.st(p)
    if (s.timer) return
    while (s.queue.length && s.active < this.cap(p)) {
      const wait = s.readyAt - this.now()
      if (wait > 0) {
        s.timer = setTimeout(() => {
          s.timer = undefined
          this.drain(p)
        }, wait)
        return
      }
      const w = s.queue.shift()!
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort)
      s.active++
      s.readyAt = this.now() + this.limits.cooldownMs
      let released = false
      w.resolve(() => {
        if (released) return
        released = true
        s.active--
        this.drain(p)
      })
    }
  }

  /** The provider said "limit reached": leave it alone until `until` (default: now + the configured backoff). */
  markLimited(provider: string, until = this.now() + this.limits.rateLimitBackoffMs): void {
    this.st(provider).limitedUntil = until
  }

  /** When the provider can be used again, or undefined if it is not limited right now. */
  limitedUntil(provider: string): number | undefined {
    const u = this.st(provider).limitedUntil
    return u !== undefined && u > this.now() ? u : undefined
  }

  snapshot(): Record<string, { running: number; queued: number; limitedUntil?: number }> {
    const out: Record<string, { running: number; queued: number; limitedUntil?: number }> = {}
    for (const [p, s] of this.states) {
      const until = this.limitedUntil(p)
      out[p] = { running: s.active, queued: s.queue.length, ...(until ? { limitedUntil: until } : {}) }
    }
    return out
  }
}
