import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpServerSchema, type McpServerConfig } from '@contracts/mcp'
import { McpCallError } from './connection'
import { McpPool, type PoolDeps } from './pool'
import { imageOf, PidRegistry } from './process'

const fx = (n: string) => fileURLToPath(new URL(`../../../tests/fixtures/${n}`, import.meta.url))
const node = process.execPath
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => imageOf(pid) !== undefined

let dir: string
let pools: McpPool[]
let notes: { agent: string; text: string }[]
let mem: number
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fa-pool-'))
  pools = []
  notes = []
  mem = 8000
})
afterEach(async () => {
  await Promise.all(pools.map((p) => p.shutdown()))
  rmSync(dir, { recursive: true, force: true })
})

/** The fake Blender: a backend (global state, one connection) behind a stdio MCP proxy. `launch` starts the backend and reports its port. */
const fake = (extras: Record<string, unknown> = {}, env: Record<string, string> = {}): McpServerConfig =>
  McpServerSchema.parse({
    command: node,
    args: [fx('fake-blender-mcp.mjs'), '{ready}'],
    env,
    description: 'fake blender',
    freeagent: { launch: { command: node, args: [fx('fake-blender-backend.mjs'), '0'], ready: 'READY (\\d+)' }, ...extras }
  })

/** A real HTTP MCP server, started by us and reporting its URL, like dcc-mcp-blender. */
const http = (extras: Record<string, unknown> = {}): McpServerConfig =>
  McpServerSchema.parse({
    url: '{ready}',
    freeagent: { launch: { command: node, args: [fx('fake-http-mcp.mjs')], ready: 'MCP_URL=(\\S+)' }, ...extras }
  })

function makePool(servers: Record<string, McpServerConfig>, over: Partial<PoolDeps> = {}): McpPool {
  const pool = new McpPool({
    servers: new Map(Object.entries(servers)),
    workDir: (s, a) => {
      const d = path.join(dir, 'work', s, a)
      mkdirSync(d, { recursive: true })
      return d
    },
    registry: new PidRegistry(path.join(dir, 'pids.json')),
    freeMemMB: () => mem,
    onNote: (agent, text) => void notes.push({ agent, text }),
    sleep: async () => undefined,
    ...over
  })
  pools.push(pool)
  return pool
}

/** What a sub-agent does with the fake: make an object, select it, think, scale it, read it back. */
async function job(pool: McpPool, agent: string, name: string, factor: number, start: number, server = 'fake'): Promise<number> {
  await sleep(start)
  const c = (tool: string, args: Record<string, unknown>) => pool.call(server, agent, tool, args)
  await c('create_object', { name })
  await c('select_object', { name })
  await sleep(80)
  await c('scale_active', { factor })
  return (JSON.parse(await c('get_object', { name })) as { scale: number }).scale
}

describe('modo shared e serialized: NON proteggono una sequenza (documentato)', () => {
  it('shared: nessun coordinamento, la scena viene sbagliata', async () => {
    const pool = makePool({ fake: fake({ concurrency: 'shared' }) })
    const [a, b] = await Promise.all([job(pool, 'A', 'A', 2, 0), job(pool, 'B', 'B', 3, 20)])
    expect({ a, b }).toEqual({ a: 1, b: 6 })
  }, 30_000)

  it('serialized: una chiamata alla volta ma la sequenza si spezza lo stesso; il secondo agente riceve la nota "in coda"', async () => {
    const pool = makePool({ fake: fake({ concurrency: 'serialized' }) })
    const [a, b] = await Promise.all([job(pool, 'A', 'A', 2, 0), job(pool, 'B', 'B', 3, 20)])
    expect({ a, b }).toEqual({ a: 1, b: 6 })
    expect(notes.some((n) => /is busy: your call is queued/.test(n.text))).toBe(true)
  }, 30_000)

  it('serialized: una connessione rifiutata viene ritentata con attesa crescente e poi riesce', async () => {
    const waits: number[] = []
    const pool = makePool({ fake: fake({ concurrency: 'serialized' }, { FAKE_FAIL_MARKER: path.join(dir, 'fail.marker') }) }, { sleep: async (ms) => void waits.push(ms) })
    expect(await pool.call('fake', 'A', 'create_object', { name: 'X' })).toBe('created X')
    expect(waits).toEqual([500])
  }, 30_000)

  it('serialized: se il guasto continua, dopo i tentativi l\'errore arriva all\'agente (non resta appeso)', async () => {
    const bad = McpServerSchema.parse({ command: node, args: ['-e', 'process.exit(1)'], freeagent: { concurrency: 'serialized' } })
    const waits: number[] = []
    const pool = makePool({ bad }, { sleep: async (ms) => void waits.push(ms) })
    await expect(pool.call('bad', 'A', 'x', {})).rejects.toThrow(/could not start|cannot connect|closed/i)
    expect(waits.length).toBeLessThanOrEqual(2)
  }, 30_000)
})

describe('modo lease: un agente alla volta per tutto il suo lavoro', () => {
  it('risultato corretto; il secondo agente aspetta con una nota e parte appena il primo ha finito', async () => {
    const pool = makePool({ fake: fake({ concurrency: 'lease' }) })
    const t0 = Date.now()
    const run = async (agent: string, name: string, f: number, start: number) => {
      const v = await job(pool, agent, name, f, start)
      await pool.releaseAgent(agent)
      return v
    }
    const [a, b] = await Promise.all([run('A', 'A', 2, 0), run('B', 'B', 3, 20)])
    expect({ a, b }).toEqual({ a: 2, b: 3 })
    expect(Date.now() - t0).toBeGreaterThan(160) // in fila
    const n = notes.find((x) => x.agent === 'B')!
    expect(n.text).toMatch(/server "fake" is busy \(held by A\): your call is queued, position 1/)
    expect(pool.status()[0]!.holder).toBeUndefined()
    expect(pool.status()[0]!.queued).toBe(0)
  }, 30_000)

  it('un titolare che sta fermo perde il server dopo leaseIdleMs, e lo sa', async () => {
    const pool = makePool({ fake: fake({ concurrency: 'lease', leaseIdleMs: 1000 }) })
    await pool.call('fake', 'A', 'create_object', { name: 'A' })
    const t0 = Date.now()
    const out = await pool.call('fake', 'B', 'create_object', { name: 'B' }) // queued behind the idle holder
    expect(out).toBe('created B')
    expect(Date.now() - t0).toBeGreaterThan(900)
    expect(notes.find((x) => x.agent === 'A')?.text).toMatch(/was released: you made no call for 1 s/)
  }, 30_000)

  it('troppa attesa: errore chiaro con il nome di chi tiene il server', async () => {
    const pool = makePool({ fake: fake({ concurrency: 'lease', queueTimeoutMs: 1000, leaseIdleMs: 60_000 }) })
    await pool.call('fake', 'A', 'create_object', { name: 'A' })
    await expect(pool.call('fake', 'B', 'create_object', { name: 'B' })).rejects.toThrow(/stayed busy for 1 s \(held by A\)/)
    expect(pool.status()[0]!.queued).toBe(0)
  }, 30_000)

  it('Stop mentre e\' in coda: rifiuta e libera la coda; chi finisce mentre aspetta viene tolto', async () => {
    const pool = makePool({ fake: fake({ concurrency: 'lease' }) })
    await pool.call('fake', 'A', 'create_object', { name: 'A' })
    const ac = new AbortController()
    const queued = pool.call('fake', 'B', 'create_object', { name: 'B' }, ac.signal)
    const other = pool.call('fake', 'C', 'create_object', { name: 'C' })
    await sleep(100)
    expect(pool.status()[0]!.queued).toBe(2)
    ac.abort()
    await expect(queued).rejects.toThrow(/stopped by the user/)
    await pool.releaseAgent('A') // C is next in line
    expect(await other).toBe('created C')
  }, 30_000)
})

describe('modo instance-per-agent: un processo per agente', () => {
  it('risultato corretto E in parallelo; ogni agente ha il suo processo; alla fine spariscono', async () => {
    const pool = makePool({ fake: fake({ concurrency: 'instance-per-agent' }) })
    const t0 = Date.now()
    const [a, b] = await Promise.all([job(pool, 'A', 'A', 2, 0), job(pool, 'B', 'B', 3, 20)])
    expect({ a, b }).toEqual({ a: 2, b: 3 })
    const inst = pool.status()[0]!.instances
    expect(inst.map((i) => i.agent).sort()).toEqual(['A', 'B'])
    expect(inst.every((i) => i.state === 'ready' && i.pid && alive(i.pid))).toBe(true)
    const pids = inst.map((i) => i.pid!)
    expect(Date.now() - t0).toBeLessThan(2500)
    await pool.releaseAgent('A')
    await pool.releaseAgent('B')
    await sleep(300)
    expect(pids.every((p) => !alive(p))).toBe(true)
    expect(pool.status()[0]!.instances).toEqual([])
  }, 30_000)

  it('cartella privata per agente: {agentDir} e\' diversa e la usa come cwd', async () => {
    const dirs: string[] = []
    const pool = makePool({ fake: fake({ concurrency: 'instance-per-agent' }) }, { workDir: (s, a) => (dirs.push(a), path.join(dir, 'w', s, a)) })
    await pool.call('fake', 'A', 'create_object', { name: 'A' }).catch(() => undefined)
    expect(dirs).toContain('A')
  }, 30_000)

  it('maxInstances: il terzo agente aspetta in coda con una nota e parte quando ne finisce uno', async () => {
    const pool = makePool({ fake: fake({ concurrency: 'instance-per-agent', maxInstances: 2 }) })
    await pool.call('fake', 'A', 'create_object', { name: 'A' })
    await pool.call('fake', 'B', 'create_object', { name: 'B' })
    let done = false
    const third = pool.call('fake', 'C', 'create_object', { name: 'C' }).then((v) => ((done = true), v))
    await sleep(400)
    expect(done).toBe(false)
    expect(pool.status()[0]).toMatchObject({ queued: 1 })
    expect(notes.find((n) => n.agent === 'C')?.text).toMatch(/2 of 2 instances are running/)
    await pool.releaseAgent('A')
    expect(await third).toBe('created C')
    expect(pool.status()[0]!.instances.map((i) => i.agent).sort()).toEqual(['B', 'C'])
  }, 30_000)

  it('poca RAM libera: il primo parte sempre, il secondo aspetta finche\' la memoria torna sopra la soglia', async () => {
    mem = 100
    const pool = makePool({ fake: fake({ concurrency: 'instance-per-agent', maxInstances: 4, minFreeMemMB: 1500 }) })
    await pool.call('fake', 'A', 'create_object', { name: 'A' }) // the first one always starts
    let done = false
    const second = pool.call('fake', 'B', 'create_object', { name: 'B' }).then(() => (done = true))
    await sleep(700)
    expect(done).toBe(false)
    expect(notes.find((n) => n.agent === 'B')?.text).toMatch(/RAM is low \(100 MB free\)/)
    mem = 8000
    await second // the pool looks again every 2 s
    expect(done).toBe(true)
  }, 30_000)

  it('un server che non parte: l\'agente riceve il perche\' (con le ultime righe) e non resta nulla in giro', async () => {
    const dead = McpServerSchema.parse({
      url: '{ready}',
      freeagent: { concurrency: 'instance-per-agent', launch: { command: node, args: ['-e', "console.error('Traceback: no module named x'); process.exit(2)"], ready: 'MCP_URL=(\\S+)' } }
    })
    const pool = makePool({ dead })
    const err = await pool.call('dead', 'A', 'x', {}).catch((e: Error) => e)
    expect(err).toBeInstanceOf(McpCallError)
    expect((err as Error).message).toMatch(/MCP server "dead" could not start[\s\S]*exited \(code 2\)[\s\S]*Traceback: no module named x/)
    expect(pool.status()[0]!.instances).toEqual([])
    // not cached: a second agent tries again from scratch
    await expect(pool.call('dead', 'B', 'x', {})).rejects.toThrow(/could not start/)
  }, 30_000)

  it('un URL che non e\' locale viene rifiutato anche se lo ha scritto il processo', async () => {
    const evil = McpServerSchema.parse({
      url: '{ready}',
      freeagent: { concurrency: 'instance-per-agent', launch: { command: node, args: ['-e', "console.log('MCP_URL=http://example.com/mcp'); setInterval(() => {}, 1000)"], ready: 'MCP_URL=(\\S+)' } }
    })
    const pool = makePool({ evil })
    await expect(pool.call('evil', 'A', 'x', {})).rejects.toThrow(/refusing to connect to a non-local address: http:\/\/example\.com\/mcp/)
    expect(pool.status()[0]!.instances).toEqual([])
  }, 30_000)

  it('restart() chiude tutto e la chiamata dopo riparte con un processo nuovo; shutdown() non lascia processi', async () => {
    const pool = makePool({ fake: fake({ concurrency: 'instance-per-agent' }) })
    await pool.call('fake', 'A', 'create_object', { name: 'A' })
    const before = pool.status()[0]!.instances[0]!.pid!
    await pool.restart('fake')
    await sleep(300)
    expect(alive(before)).toBe(false)
    await pool.call('fake', 'A', 'create_object', { name: 'A' })
    const after = pool.status()[0]!.instances[0]!.pid!
    expect(after).not.toBe(before)
    await pool.shutdown()
    await sleep(300)
    expect(alive(after)).toBe(false)
  }, 30_000)
})

describe('server HTTP vero (come dcc-mcp-blender): avvio, MCP_URL, initCalls, tool consentiti', () => {
  const cfg = () =>
    http({
      concurrency: 'instance-per-agent',
      initCalls: [{ tool: 'load_skill', arguments: { skill_name: 'scripting' } }],
      allowTools: ['scripting__*'],
      health: { tool: 'scripting__where' }
    })

  it('l\'initCall carica la skill, i tool di terze parti non sono raggiungibili, ogni agente ha il proprio processo', async () => {
    const pool = makePool({ blender: cfg() })
    expect(await pool.call('blender', 'A', 'scripting__echo', { text: 'ciao' })).toBe('ciao') // works only because initCalls ran load_skill
    const pidA = await pool.call('blender', 'A', 'scripting__where', {})
    const pidB = await pool.call('blender', 'B', 'scripting__where', {})
    expect(pidA).not.toBe(pidB)
    await expect(pool.call('blender', 'A', 'register_tool', {})).rejects.toThrow(/tool "register_tool" is not available on "blender"/)
    await expect(pool.call('blender', 'A', 'load_skill', { skill_name: 'x' })).rejects.toThrow(/not available/)
  }, 60_000)

  it('tools() mostra solo i consentiti, li ricorda su file, e il messaggio di errore li elenca', async () => {
    const catalogFile = path.join(dir, 'catalog.json')
    const pool = makePool({ blender: cfg() }, { catalogFile })
    expect(pool.knownTools('blender')).toEqual({ names: undefined, patterns: ['scripting__*'] })
    const t = await pool.tools('blender', 'A')
    expect(t.map((x) => x.name).sort()).toEqual(['scripting__echo', 'scripting__where'])
    expect(pool.status()[0]!.tools).toEqual(t.map((x) => x.name))
    await expect(pool.call('blender', 'A', 'inject', {})).rejects.toThrow(/Available: scripting__echo, scripting__where/)
    const again = makePool({ blender: cfg() }, { catalogFile }) // a new run knows the names before starting anything
    expect(again.knownTools('blender').names?.sort()).toEqual(['scripting__echo', 'scripting__where'])
    expect(again.status()[0]!.instances).toEqual([])
  }, 60_000)

  it('server sconosciuto: errore con i nomi disponibili', async () => {
    const pool = makePool({ blender: cfg() })
    await expect(pool.call('nope', 'A', 'x', {})).rejects.toThrow(/unknown MCP server "nope". Available: blender/)
  })
})

describe('Blender non installato', () => {
  it('l\'agente riceve un messaggio chiaro invece di un errore criptico', async () => {
    const cfg = McpServerSchema.parse({ url: '{ready}', freeagent: { concurrency: 'instance-per-agent', launch: { command: '{blenderExe}', args: [], ready: 'MCP_URL=(\S+)' } } })
    const pool = makePool({ blender: cfg }, { vars: { blenderExe: '' } })
    await expect(pool.call('blender', 'A', 'x', {})).rejects.toThrow(/Blender was not found on this PC: install it, or set FREEAGENT_BLENDER/)
  })
})
