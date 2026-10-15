import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadAgentsConfig } from './agents-config'

let dir: string
beforeEach(() => void (dir = mkdtempSync(path.join(tmpdir(), 'fa-agents-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const write = (v: unknown) => {
  const f = path.join(dir, 'agents.json')
  writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v))
  return f
}
const TOOLS = ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'render', 'look', 'delegate']
const PROVIDERS = ['deepseek', 'qwen', 'kimi']

describe('loadAgentsConfig', () => {
  it('config/agents.json del progetto e\' valido: modeler (Blender) e builder su deepseek, la vista su qwen, entrambi con render, look e la skill visual-check', () => {
    const r = loadAgentsConfig(fileURLToPath(new URL('../../config/agents.json', import.meta.url)), TOOLS, PROVIDERS, ['visual-check'], ['blender'])
    expect(r.problems).toEqual([])
    expect(r.config.agents.map((a) => `${a.name}:${a.provider}:${(a.mcp ?? []).join()}`)).toEqual(['modeler:deepseek:blender', 'builder:deepseek:'])
    expect(r.config.agents.every((a) => a.tools.includes('render') && a.tools.includes('look') && a.skills.includes('visual-check'))).toBe(true)
    expect(r.config.vision).toEqual({ provider: 'qwen', maxCalls: 10 })
    expect(r.config.limits).toMatchObject({ default: 2, cooldownMs: 1500 })
  })

  it('vision: provider valido = look attivo; provider sconosciuto o forma sbagliata = niente vision e il motivo, gli agenti restano', () => {
    const ok = loadAgentsConfig(write({ vision: { provider: 'qwen', model: 'Qwen3.8-Max' }, agents: [] }), TOOLS, PROVIDERS)
    expect(ok.problems).toEqual([])
    expect(ok.config.vision).toEqual({ provider: 'qwen', model: 'Qwen3.8-Max', maxCalls: 10 })
    const unknown = loadAgentsConfig(write({ vision: { provider: 'nessuno' }, agents: [{ name: 'a', description: 'd', provider: 'qwen' }] }), TOOLS, PROVIDERS)
    expect(unknown.config.vision).toBeUndefined()
    expect(unknown.problems[0]).toMatch(/vision: unknown provider "nessuno".*no look tool/)
    expect(unknown.config.agents).toHaveLength(1)
    const bad = loadAgentsConfig(write({ vision: 'qwen', agents: [] }), TOOLS, PROVIDERS)
    expect(bad.config.vision).toBeUndefined()
    expect(bad.problems[0]).toMatch(/^vision:/)
    expect(loadAgentsConfig(write({ agents: [] }), TOOLS, PROVIDERS).config.vision).toBeUndefined()
  })

  it('default dei limiti e override per provider', () => {
    const r = loadAgentsConfig(write({ limits: { default: 1, perProvider: { qwen: 2 }, cooldownMs: 0 }, agents: [] }), TOOLS, PROVIDERS)
    expect(r.config.limits).toEqual({ default: 1, perProvider: { qwen: 2 }, cooldownMs: 0, rateLimitBackoffMs: 600000, maxWaitMs: 120000 })
  })

  it('un agente valido prende i default; uno sbagliato viene scartato con il motivo, gli altri restano', () => {
    const r = loadAgentsConfig(
      write({
        agents: [
          { name: 'analyst', description: 'legge', provider: 'qwen' },
          { name: 'Bad Name', description: 'x', provider: 'qwen' },
          { name: 'ghost', description: 'x', provider: 'nope' },
          { name: 'tooly', description: 'x', provider: 'qwen', tools: ['read', 'rm'] },
          { name: 'rec', description: 'x', provider: 'qwen', tools: ['delegate'] },
          { name: 'analyst', description: 'doppione', provider: 'qwen' },
          { name: 'ok2', description: 'x', provider: 'deepseek', fallback: ['kimi', 'zzz'] }
        ]
      }),
      TOOLS,
      PROVIDERS
    )
    expect(r.config.agents.map((a) => a.name)).toEqual(['analyst'])
    expect(r.config.agents[0]).toMatchObject({ tools: ['read', 'glob', 'grep'], maxSteps: 20, fallback: [] })
    expect(r.problems).toHaveLength(6) // bad name, ghost, tooly, rec, duplicate, ok2
    expect(r.problems.join('\n')).toMatch(/unknown provider "nope"/)
    expect(r.problems.join('\n')).toMatch(/unknown tool "rm"/)
    expect(r.problems.join('\n')).toMatch(/unknown tool "delegate"/)
    expect(r.problems.join('\n')).toMatch(/defined twice/)
    expect(r.problems.join('\n')).toMatch(/unknown provider "zzz"/)
  })

  it('una skill che non esiste scarta l agente; una installata passa', () => {
    const rows = [
      { name: 'a', description: 'x', provider: 'qwen', skills: ['ponytail'] },
      { name: 'b', description: 'x', provider: 'qwen', skills: ['ghost'] }
    ]
    const r = loadAgentsConfig(write({ agents: rows }), TOOLS, PROVIDERS, ['ponytail'])
    expect(r.config.agents.map((x) => x.name)).toEqual(['a'])
    expect(r.problems.join()).toMatch(/unknown skill "ghost" \(installed: ponytail\)/)
  })

  it('un server MCP che non esiste scarta l agente', () => {
    const rows = [
      { name: 'a', description: 'x', provider: 'qwen', mcp: ['blender'] },
      { name: 'b', description: 'x', provider: 'qwen', mcp: ['ghost'] }
    ]
    const r = loadAgentsConfig(write({ agents: rows }), TOOLS, PROVIDERS, [], ['blender'])
    expect(r.config.agents.map((x) => x.name)).toEqual(['a'])
    expect(r.problems.join()).toMatch(/unknown MCP server "ghost" \(configured: blender\)/)
  })

  it('limiti non validi: default e un avviso; file rotto: errore chiaro', () => {
    const r = loadAgentsConfig(write({ limits: { default: 99 } }), TOOLS, PROVIDERS)
    expect(r.config.limits.default).toBe(2)
    expect(r.problems[0]).toMatch(/limits:/)
    expect(() => loadAgentsConfig(write('{broken'), TOOLS, PROVIDERS)).toThrow(/cannot read/)
  })
})
