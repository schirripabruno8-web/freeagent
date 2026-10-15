import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpServerSchema } from '@contracts/mcp'
import { probeServer } from './probe'
import { PidRegistry } from './process'

const fx = (n: string) => fileURLToPath(new URL(`../../../tests/fixtures/${n}`, import.meta.url))
const node = process.execPath

let dir: string
beforeEach(() => void (dir = mkdtempSync(path.join(tmpdir(), 'fa-probe-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const deps = () => ({
  workDir: (s: string, a: string) => {
    const d = path.join(dir, s, a)
    mkdirSync(d, { recursive: true })
    return d
  },
  registry: new PidRegistry(path.join(dir, 'pids.json'))
})

describe('probeServer', () => {
  it('avvia il server, elenca gli strumenti (rispettando allow/deny) e lo spegne', async () => {
    const cfg = McpServerSchema.parse({ url: '{ready}', freeagent: { launch: { command: node, args: [fx('fake-http-mcp.mjs')], ready: 'MCP_URL=(\\S+)' } } })
    const r = await probeServer('fakehttp', cfg, deps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tools.length).toBeGreaterThan(0)
    const none = await probeServer('fakehttp', McpServerSchema.parse({ ...cfg, freeagent: { ...cfg.freeagent, denyTools: ['*'] } }), deps())
    expect(none).toEqual({ ok: true, tools: [] })
  }, 30_000)

  it('un programma che non esiste: ok=false con il motivo, senza lanciare', async () => {
    const r = await probeServer('rotto', McpServerSchema.parse({ command: 'questo-programma-non-esiste-xyz' }), deps())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/rotto/)
  }, 30_000)

  it('non lascia processi: il registro dei PID e vuoto e il server avviato non risponde piu', async () => {
    const d = deps()
    const cfg = McpServerSchema.parse({ url: '{ready}', freeagent: { launch: { command: node, args: [fx('fake-http-mcp.mjs')], ready: 'MCP_URL=(\\S+)' } } })
    expect((await probeServer('fakehttp', cfg, d)).ok).toBe(true)
    expect(JSON.parse(readFileSync(path.join(dir, 'pids.json'), 'utf8'))).toEqual([])
  }, 30_000)
})
