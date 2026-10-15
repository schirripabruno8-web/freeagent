import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findBlender } from './detect'
import { expandVars, loadMcpConfig, matchTool, toolAllowed, toolReadOnly } from './profile'

let dir: string
beforeEach(() => void (dir = mkdtempSync(path.join(tmpdir(), 'fa-mcpcfg-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const write = (v: unknown) => {
  const f = path.join(dir, 'mcp.json')
  writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v))
  return f
}

describe('loadMcpConfig', () => {
  it('un .mcp.json normale funziona: i campi nostri prendono i default (lease, niente launch)', () => {
    const r = loadMcpConfig(write({ mcpServers: { fs: { command: 'npx', args: ['-y', 'x'], env: { A: '1' } } } }))
    expect(r.problems).toEqual([])
    const s = r.servers.get('fs')!
    expect(s).toMatchObject({ command: 'npx', args: ['-y', 'x'], env: { A: '1' } })
    expect(s.freeagent).toMatchObject({ concurrency: 'lease', maxInstances: 4, headless: true, mainAccess: true, denyTools: [] })
  })

  it('un server sbagliato viene scartato con il motivo; gli altri restano', () => {
    const r = loadMcpConfig(
      write({
        mcpServers: {
          good: { command: 'x' },
          'Bad Name': { command: 'x' },
          nothing: {},
          badmode: { command: 'x', freeagent: { concurrency: 'parallel' } },
          urlonly: { url: 'http://127.0.0.1:1/mcp', freeagent: { concurrency: 'instance-per-agent' } }
        }
      })
    )
    expect([...r.servers.keys()]).toEqual(['good'])
    expect(r.problems).toHaveLength(4)
    const all = r.problems.join('\n')
    expect(all).toMatch(/lowercase/)
    expect(all).toMatch(/needs a "command".*or a "url"/)
    expect(all).toMatch(/concurrency/)
    expect(all).toMatch(/instance-per-agent with only a "url" needs a "launch"/)
  })

  it('config/mcp.json del progetto e\' valido e spegne i tool di terze parti', () => {
    const r = loadMcpConfig(fileURLToPath(new URL('../../../config/mcp.json', import.meta.url)))
    expect(r.problems).toEqual([])
    const b = r.servers.get('blender')!
    expect(b.freeagent.concurrency).toBe('instance-per-agent')
    expect(toolAllowed(b, 'execute_python')).toBe(true)
    expect(toolAllowed(b, 'get_blender_info')).toBe(true)
    expect(toolAllowed(b, 'blender_scripting__execute_python')).toBe(true)
    for (const t of ['register_tool', 'qt_ui_inspector__list_windows', 'load_skill', 'dcc_diagnostics__screenshot', 'execute_script_file', 'materialize_script', 'dcc_introspect__eval']) expect(toolAllowed(b, t), t).toBe(false)
  })

  it('file rotto o mcpServers non oggetto: errore chiaro', () => {
    expect(() => loadMcpConfig(write('{nope'))).toThrow(/cannot read/)
    expect(() => loadMcpConfig(write({ mcpServers: [] }))).toThrow(/must be an object/)
    expect(loadMcpConfig(write({})).servers.size).toBe(0)
  })
})

describe('tool allow/deny', () => {
  const cfg = (x: object) => loadMcpConfig(write({ mcpServers: { s: { command: 'x', freeagent: x } } })).servers.get('s')!

  it('wildcard * e solo quello (il punto e le parentesi sono letterali)', () => {
    expect(matchTool('a*', 'abc')).toBe(true)
    expect(matchTool('*_ops', 'mesh_ops')).toBe(true)
    expect(matchTool('a.c', 'abc')).toBe(false)
    expect(matchTool('x(y)', 'x(y)')).toBe(true)
    expect(matchTool('exact', 'exactly')).toBe(false)
  })

  it('senza allowlist passa tutto tranne i deny; con allowlist solo quello; deny vince', () => {
    expect(toolAllowed(cfg({}), 'anything')).toBe(true)
    expect(toolAllowed(cfg({ denyTools: ['load_*'] }), 'load_skill')).toBe(false)
    const c = cfg({ allowTools: ['blender_scripting__*'], denyTools: ['blender_scripting__execute_script_file'] })
    expect(toolAllowed(c, 'blender_scripting__execute_python')).toBe(true)
    expect(toolAllowed(c, 'blender_scripting__execute_script_file')).toBe(false)
    expect(toolAllowed(c, 'register_tool')).toBe(false)
  })

  it('i tool di sola lettura sono riconosciuti', () => {
    const c = cfg({ readOnlyTools: ['*get_blender_info'] })
    expect(toolReadOnly(c, 'blender_scripting__get_blender_info')).toBe(true)
    expect(toolReadOnly(c, 'blender_scripting__execute_python')).toBe(false)
  })
})

describe('expandVars', () => {
  it('%VAR% dall\'ambiente e solo i segnaposto noti; le altre graffe restano', () => {
    const v = { port: '123', agentDir: 'D:\\w\\a1', ready: 'http://127.0.0.1:9/mcp' }
    expect(expandVars('%APPDATA%\\x', v, { APPDATA: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\x')
    expect(expandVars('--port={port} {agentDir} {ready}', v)).toBe('--port=123 D:\\w\\a1 http://127.0.0.1:9/mcp')
    expect(expandVars('{"a": 1} {unknown} {port}', v)).toBe('{"a": 1} {unknown} 123')
    expect(expandVars('%NOPE%', v, {})).toBe('%NOPE%')
  })
})

describe('findBlender', () => {
  const dirs: Record<string, string[]> = { 'C:\\Program Files\\Blender Foundation': ['Blender 4.5', 'Blender 5.1', 'Blender 5.0', 'Other'] }
  const exists = (p: string) => /blender\.exe$/.test(p)
  const list = (p: string) => {
    if (!dirs[p]) throw new Error('ENOENT')
    return dirs[p]!
  }

  it('sceglie la versione piu\' recente, ignora cartelle non Blender', () => {
    expect(findBlender({}, exists, list)).toBe('C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe')
  })
  it('FREEAGENT_BLENDER vince; niente Blender = undefined', () => {
    expect(findBlender({ FREEAGENT_BLENDER: 'D:\\b\\blender.exe' }, () => true, list)).toBe('D:\\b\\blender.exe')
    expect(findBlender({}, () => false, list)).toBeUndefined()
  })
})
