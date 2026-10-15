import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * FASE 4, test di riproduzione. Ipotesi dell'utente: se due sub-agenti usano insieme lo stesso server MCP con stato
 * (come Blender: una scena, un oggetto attivo globale, una sola connessione) uno riceve errori o i comandi si sovrappongono.
 * Il server finto (tests/fixtures) ha esattamente quelle due proprieta' e nessuna dipendenza da Blender.
 * I test "RIPRODUZIONE" asseriscono il comportamento SBAGLIATO: documentano il problema. Gli ultimi due mostrano che
 * "lease per agente" e "istanza per agente" lo risolvono (prototipi minimi qui sotto; l'implementazione vera viene dopo l'ok).
 */
const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

async function startBackend(): Promise<number> {
  const p: ChildProcess = spawn(process.execPath, [fx('fake-blender-backend.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] })
  cleanup.push(() => p.kill())
  return new Promise((resolve, reject) => {
    p.stdout!.on('data', (d: Buffer) => {
      const m = /READY (\d+)/.exec(String(d))
      if (m) resolve(Number(m[1]))
    })
    p.on('error', reject)
  })
}

async function connect(port: number): Promise<Client> {
  const c = new Client({ name: 'agent', version: '1' })
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [fx('fake-blender-mcp.mjs'), String(port)] }))
  cleanup.push(() => void c.close())
  return c
}

const call = async (c: Client, name: string, args: Record<string, unknown>): Promise<string> => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
  const text = r.content[0]!.text
  if (r.isError) throw new Error(text)
  return text
}

/** What a sub-agent does: make its object, select it, "think" a bit (the model is slow between calls), scale it, read it back. */
async function agentJob(c: Client, name: string, factor: number, start: number): Promise<number> {
  await sleep(start)
  await call(c, 'create_object', { name })
  await call(c, 'select_object', { name })
  await sleep(80)
  await call(c, 'scale_active', { factor })
  return (JSON.parse(await call(c, 'get_object', { name })) as { scale: number }).scale
}

/** Prototype: one call at a time (what "serialized" means in the brief). */
const perCallMutex = (c: Client): Client => {
  let tail: Promise<unknown> = Promise.resolve()
  return new Proxy(c, {
    get: (t, k) =>
      k === 'callTool'
        ? (...a: Parameters<Client['callTool']>) => {
            const run = tail.then(() => t.callTool(...a))
            tail = run.catch(() => undefined)
            return run
          }
        : (t as never)[k]
  })
}

/** Prototype: one agent at a time for its WHOLE job. */
const lease = () => {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job)
    tail = run.catch(() => undefined)
    return run
  }
}

describe('RIPRODUZIONE: due agenti sullo stesso server MCP con stato', () => {
  it('1) un client MCP ciascuno: il server accetta una sola connessione, il secondo agente riceve un errore', async () => {
    const port = await startBackend()
    const [ca, cb] = [await connect(port), await connect(port)]
    const r = await Promise.allSettled([agentJob(ca, 'A', 2, 0), agentJob(cb, 'B', 3, 20)])
    const failed = r.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]
    expect(failed).toHaveLength(1)
    expect(String(failed[0]!.reason)).toMatch(/busy/)
  })

  it('2) un client condiviso senza coordinamento: nessun errore, ma i comandi si sovrappongono e la scena e\' SBAGLIATA', async () => {
    const port = await startBackend()
    const c = await connect(port)
    const [a, b] = await Promise.all([agentJob(c, 'A', 2, 0), agentJob(c, 'B', 3, 20)])
    // expected a === 2 and b === 3. B selected after A, so A's scale hit B's object, then B's own scale hit it again.
    expect({ a, b }).toEqual({ a: 1, b: 6 })
  })

  it('3) coda per chiamata (mutex): ogni chiamata e\' atomica ma la sequenza select+scale NON lo e\': stesso errore', async () => {
    const port = await startBackend()
    const c = perCallMutex(await connect(port))
    const [a, b] = await Promise.all([agentJob(c, 'A', 2, 0), agentJob(c, 'B', 3, 20)])
    expect({ a, b }).toEqual({ a: 1, b: 6 })
  })
})

describe('RIPRODUZIONE: cosa lo risolve', () => {
  it('4) lease per agente (un agente alla volta per tutto il suo lavoro): risultato corretto, ma in fila', async () => {
    const port = await startBackend()
    const c = await connect(port)
    const exclusive = lease()
    const t0 = Date.now()
    const [a, b] = await Promise.all([exclusive(() => agentJob(c, 'A', 2, 0)), exclusive(() => agentJob(c, 'B', 3, 20))])
    expect({ a, b }).toEqual({ a: 2, b: 3 })
    expect(Date.now() - t0).toBeGreaterThan(160) // two jobs of ~80 ms each, one after the other
  })

  it('5) un\'istanza del server per agente (porte diverse): risultato corretto E in parallelo', async () => {
    const [p1, p2] = [await startBackend(), await startBackend()]
    const [ca, cb] = [await connect(p1), await connect(p2)]
    const t0 = Date.now()
    const [a, b] = await Promise.all([agentJob(ca, 'A', 2, 0), agentJob(cb, 'B', 3, 20)])
    const dt = Date.now() - t0
    expect({ a, b }).toEqual({ a: 2, b: 3 })
    expect(dt).toBeLessThan(350)
  })
})
