import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Limits } from '@contracts/agents'
import { Scheduler } from './scheduler'

const limits = (over: Partial<Limits> = {}): Limits => ({
  default: 1, perProvider: {}, cooldownMs: 0, rateLimitBackoffMs: 60_000, maxWaitMs: 120_000, ...over
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('Scheduler', () => {
  it('limite 1: il secondo aspetta il rilascio del primo, in ordine di arrivo', async () => {
    const s = new Scheduler(limits())
    const order: string[] = []
    const r1 = await s.acquire('deepseek')
    const p2 = s.acquire('deepseek').then((r) => (order.push('2'), r))
    const p3 = s.acquire('deepseek').then((r) => (order.push('3'), r))
    await flush()
    expect(order).toEqual([])
    expect(s.snapshot().deepseek).toEqual({ running: 1, queued: 2 })
    r1()
    const r2 = await p2
    expect(order).toEqual(['2'])
    r2()
    await p3
    expect(order).toEqual(['2', '3'])
  })

  it('limite 2 (default) e override per provider; provider diversi non si bloccano a vicenda', async () => {
    const s = new Scheduler(limits({ default: 2, perProvider: { chatgpt: 1 } }))
    await s.acquire('qwen')
    await s.acquire('qwen')
    let third = false
    void s.acquire('qwen').then(() => (third = true))
    await s.acquire('chatgpt') // another provider: immediate
    let second = false
    void s.acquire('chatgpt').then(() => (second = true))
    await flush()
    expect(third).toBe(false)
    expect(second).toBe(false) // chatgpt is capped at 1
  })

  it('pausa tra due avvii sullo stesso provider (cooldown)', async () => {
    const s = new Scheduler(limits({ default: 2, cooldownMs: 1500 }))
    const t0 = Date.now()
    const times: number[] = []
    for (let i = 0; i < 2; i++) void s.acquire('x').then(() => times.push(Date.now() - t0))
    await vi.advanceTimersByTimeAsync(0)
    expect(times).toEqual([0])
    await vi.advanceTimersByTimeAsync(1499)
    expect(times).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    expect(times).toEqual([0, 1500])
  })

  it('abort mentre e\' in coda: rifiuta e non blocca chi viene dopo', async () => {
    const s = new Scheduler(limits())
    const r1 = await s.acquire('x')
    const ac = new AbortController()
    const waiting = s.acquire('x', ac.signal)
    const after = s.acquire('x')
    ac.abort()
    await expect(waiting).rejects.toThrow('aborted')
    r1()
    await expect(after).resolves.toBeTypeOf('function')
    expect(s.snapshot().x).toEqual({ running: 1, queued: 0 })
  })

  it('un segnale gia\' abortito rifiuta subito; il rilascio e\' idempotente', async () => {
    const s = new Scheduler(limits())
    const ac = new AbortController()
    ac.abort()
    await expect(s.acquire('x', ac.signal)).rejects.toThrow('aborted')
    const r = await s.acquire('x')
    r()
    r()
    expect(s.snapshot().x).toEqual({ running: 0, queued: 0 })
    await s.acquire('x')
    let second = false
    void s.acquire('x').then(() => (second = true))
    await flush()
    expect(second).toBe(false) // a double release must not have freed a slot it did not own
  })

  it('markLimited: attivo fino alla scadenza, poi sparisce', () => {
    const s = new Scheduler(limits({ rateLimitBackoffMs: 5000 }))
    expect(s.limitedUntil('x')).toBeUndefined()
    s.markLimited('x')
    expect(s.limitedUntil('x')).toBe(Date.now() + 5000)
    expect(s.snapshot().x).toMatchObject({ limitedUntil: Date.now() + 5000 })
    vi.advanceTimersByTime(5001)
    expect(s.limitedUntil('x')).toBeUndefined()
    s.markLimited('y', Date.now() + 100)
    expect(s.limitedUntil('y')).toBe(Date.now() + 100)
  })
})
