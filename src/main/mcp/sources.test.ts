import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpServerSchema, type McpNewServer } from '@contracts/mcp'
import { addUserServers, describeServers, isRemote, loadSources, removeUserServer, summaryOf } from './sources'

let dir: string
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
const files = () => {
  dir = mkdtempSync(path.join(tmpdir(), 'fa-sources-'))
  return { bundled: path.join(dir, 'mcp.json'), user: path.join(dir, 'sub', 'mcp.user.json') }
}
const put = (file: string, mcpServers: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ mcpServers }))
const stdio = (name: string, extra: Partial<McpNewServer> = {}): McpNewServer => ({ name, config: { type: 'stdio', command: 'npx', args: ['-y', `@x/${name}`] }, ...extra })

describe('loadSources', () => {
  it('unisce i server inclusi e quelli aggiunti; i spenti restano in elenco ma non vanno al pool', () => {
    const f = files()
    put(f.bundled, { blender: { command: 'b' }, git: { command: 'g' } })
    expect(addUserServers(f.user, [stdio('fetch')], ['blender', 'git'])).toEqual(['fetch'])
    const s = loadSources(f.bundled, f.user, ['git', 'fetch'])
    expect(s.all.map((x) => [x.name, x.source, x.enabled])).toEqual([['blender', 'bundled', true], ['git', 'bundled', false], ['fetch', 'user', false]])
    expect([...s.servers.keys()]).toEqual(['blender'])
    expect(s.problems).toEqual([])
  })

  it('un server tuo con il nome di uno incluso viene ignorato e lo dice; vince quello incluso', () => {
    const f = files()
    put(f.bundled, { blender: { command: 'b' } })
    addUserServers(f.user, [stdio('x')], [])
    put(f.user, { blender: { command: 'altro' }, ok: { command: 'o' } })
    const s = loadSources(f.bundled, f.user, [])
    expect(s.all.map((x) => x.name)).toEqual(['blender', 'ok'])
    expect(s.all[0]!.config.command).toBe('b')
    expect(s.problems.join('\n')).toMatch(/"blender" ignored/)
  })

  it('senza file utente va tutto bene; file utente rotto: problema segnalato, i server inclusi restano', () => {
    const f = files()
    put(f.bundled, { blender: { command: 'b' } })
    expect(loadSources(f.bundled, f.user, []).problems).toEqual([])
    addUserServers(f.user, [stdio('a')], [])
    writeFileSync(f.user, '{ rotto')
    const s = loadSources(f.bundled, f.user, [])
    expect(s.all.map((x) => x.name)).toEqual(['blender'])
    expect(s.problems[0]).toMatch(/^mcp\.user\.json: cannot read/)
  })

  it('un server tuo sbagliato a mano: gli altri restano e il problema porta il prefisso del file', () => {
    const f = files()
    put(f.bundled, { blender: { command: 'b' } })
    addUserServers(f.user, [stdio('a')], [])
    put(f.user, { Brutto: { command: 'x' }, buono: { command: 'y' } })
    const s = loadSources(f.bundled, f.user, [])
    expect(s.all.map((x) => x.name)).toEqual(['blender', 'buono'])
    expect(s.problems[0]).toMatch(/^mcp\.user\.json: server "Brutto"/)
  })

  it('config/mcp.json illeggibile: problema, ma il resto non crolla', () => {
    const f = files()
    expect(loadSources(f.bundled, f.user, []).problems[0]).toMatch(/cannot read/)
  })
})

describe('addUserServers', () => {
  it('scrive solo il necessario (env solo se c\'e), il file e valido per lo schema e non lascia temporanei', () => {
    const f = files()
    addUserServers(f.user, [{ name: 'files', config: { type: 'stdio', command: 'npx', args: ['-y', 'p', 'D:\\w'], env: { K: 'v' } }, description: 'd', mainAccess: false, concurrency: 'shared' }, stdio('plain')], [])
    const raw = JSON.parse(readFileSync(f.user, 'utf8')).mcpServers
    expect(raw.files).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'p', 'D:\\w'], env: { K: 'v' }, description: 'd', freeagent: { concurrency: 'shared', mainAccess: false } })
    expect(raw.plain).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@x/plain'], freeagent: { concurrency: 'lease', mainAccess: true } })
    expect(McpServerSchema.safeParse(raw.files).success).toBe(true)
    expect(readdirSync(path.dirname(f.user))).toEqual(['mcp.user.json'])
  })

  it('aggiunge a quelli che ci sono gia senza toccarli', () => {
    const f = files()
    addUserServers(f.user, [stdio('uno')], [])
    addUserServers(f.user, [stdio('due')], [])
    expect(Object.keys(JSON.parse(readFileSync(f.user, 'utf8')).mcpServers)).toEqual(['uno', 'due'])
  })

  it('rifiuta: nome non valido, doppio (usato, nel file, nel lotto), niente da aggiungere; nulla viene scritto', () => {
    const f = files()
    addUserServers(f.user, [stdio('uno')], [])
    const before = readFileSync(f.user, 'utf8')
    expect(() => addUserServers(f.user, [stdio('Brutto')], [])).toThrow(/the name must be/)
    expect(() => addUserServers(f.user, [stdio('9x')], [])).toThrow(/the name must be/)
    expect(() => addUserServers(f.user, [stdio('uno')], [])).toThrow(/already a server named "uno"/)
    expect(() => addUserServers(f.user, [stdio('blender')], ['blender'])).toThrow(/already a server named "blender"/)
    expect(() => addUserServers(f.user, [stdio('a'), stdio('a')], [])).toThrow(/already a server named "a"/)
    expect(() => addUserServers(f.user, [stdio('buono'), stdio('Brutto')], [])).toThrow(/the name must be/)
    expect(() => addUserServers(f.user, [], [])).toThrow(/nothing to add/)
    expect(readFileSync(f.user, 'utf8')).toBe(before)
  })

  it('http: https va bene, http in chiaro solo verso questo PC, il resto e rifiutato', () => {
    const f = files()
    const web = (url: string): McpNewServer => ({ name: 'web', config: { type: 'http', url } })
    expect(() => addUserServers(f.user, [web('http://example.com/mcp')], [])).toThrow(/plain http is only allowed/)
    expect(() => addUserServers(f.user, [web('non un indirizzo')], [])).toThrow(/is not an address/)
    expect(() => addUserServers(f.user, [web('ftp://x.example/')], [])).toThrow(/plain http/)
    expect(addUserServers(f.user, [web('http://127.0.0.1:8080/mcp')], [])).toEqual(['web'])
    removeUserServer(f.user, 'web')
    expect(addUserServers(f.user, [web('https://mcp.example.com/mcp')], [])).toEqual(['web'])
  })

  it('un file utente che non e JSON non viene mai sovrascritto', () => {
    const f = files()
    addUserServers(f.user, [stdio('uno')], [])
    writeFileSync(f.user, '{ modificato a mano e rotto')
    expect(() => addUserServers(f.user, [stdio('due')], [])).toThrow(/not valid JSON/)
    expect(readFileSync(f.user, 'utf8')).toBe('{ modificato a mano e rotto')
    expect(() => removeUserServer(f.user, 'uno')).toThrow(/not valid JSON/)
    writeFileSync(f.user, JSON.stringify({ mcpServers: [] }))
    expect(() => addUserServers(f.user, [stdio('due')], [])).toThrow(/must be an object/)
  })

  it('descrizione oltre 300 caratteri: tagliata, il server non viene scartato', () => {
    const f = files()
    addUserServers(f.user, [stdio('lungo', { description: 'x'.repeat(500) })], [])
    expect(loadSources(path.join(f.user, 'nope'), f.user, []).all.map((x) => x.name)).toEqual(['lungo'])
  })
})

describe('removeUserServer', () => {
  it('toglie solo quello chiesto; uno che non c\'e (o un file assente) risponde false', () => {
    const f = files()
    expect(removeUserServer(f.user, 'uno')).toBe(false)
    addUserServers(f.user, [stdio('uno'), stdio('due')], [])
    expect(removeUserServer(f.user, 'uno')).toBe(true)
    expect(removeUserServer(f.user, 'uno')).toBe(false)
    expect(Object.keys(JSON.parse(readFileSync(f.user, 'utf8')).mcpServers)).toEqual(['due'])
  })
})

describe('summaryOf / isRemote', () => {
  const cfg = (o: Record<string, unknown>) => McpServerSchema.parse(o)
  it('il riassunto non mostra mai le variabili d\'ambiente ne la query di un indirizzo', () => {
    expect(summaryOf(cfg({ command: 'npx', args: ['-y', 'p'], env: { API_KEY: 'segreto' } }))).toBe('npx -y p')
    expect(summaryOf(cfg({ url: 'https://u:pw@h.example/mcp?token=segreto' }))).toBe('https://h.example/mcp')
    expect(summaryOf(cfg({ command: 'x'.repeat(400) })).length).toBe(160)
    expect(summaryOf(cfg({ url: '{ready}', freeagent: { launch: { command: 'blender', args: ['--background'], env: { K: 'segreto' } } } }))).toBe('blender --background')
  })

  it('remoto = un indirizzo che non e questo PC; un programma avviato qui (anche se parla http) no', () => {
    expect(isRemote(cfg({ url: 'https://mcp.example.com/mcp' }))).toBe(true)
    expect(isRemote(cfg({ url: 'http://127.0.0.1:9/mcp' }))).toBe(false)
    expect(isRemote(cfg({ url: 'http://localhost:9/mcp' }))).toBe(false)
    expect(isRemote(cfg({ command: 'npx' }))).toBe(false)
    expect(isRemote(cfg({ url: '{ready}', freeagent: { launch: { command: 'x' } } }))).toBe(false)
  })
})

describe('describeServers', () => {
  it('lo stato vivo del pool solo per i server accesi; uno spento resta in elenco, fermo, con origine e riassunto', () => {
    const f = files()
    put(f.bundled, { blender: { command: 'b', description: 'dcc', env: { K: 'segreto' } }, git: { command: 'g' } })
    addUserServers(f.user, [{ name: 'web', config: { type: 'http', url: 'https://h.example/mcp?k=1' } }], ['blender', 'git'])
    const s = loadSources(f.bundled, f.user, ['git'])
    const live = [
      { name: 'blender', mode: 'lease' as const, instances: [{ agent: 'shared', state: 'ready' as const, pid: 7 }], queued: 1, holder: 'main', tools: ['a'] },
      { name: 'git', mode: 'lease' as const, instances: [{ agent: 'x', state: 'ready' as const }], queued: 0 }
    ]
    const rows = describeServers(s.all, live)
    expect(rows.map((r) => [r.name, r.enabled, r.source, r.remote])).toEqual([['blender', true, 'bundled', false], ['git', false, 'bundled', false], ['web', true, 'user', true]])
    expect(rows[0]).toMatchObject({ description: 'dcc', instances: [{ agent: 'shared', state: 'ready', pid: 7 }], queued: 1, holder: 'main', tools: ['a'], summary: 'b' })
    expect(rows[1]).toMatchObject({ instances: [], queued: 0 }) // off: whatever the pool still remembers is not shown
    expect(rows[2]).toMatchObject({ instances: [], queued: 0, mode: 'lease', summary: 'https://h.example/mcp' })
    expect(JSON.stringify(rows)).not.toContain('segreto')
  })
})
