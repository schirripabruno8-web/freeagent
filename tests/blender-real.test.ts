import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { findBlender } from '../src/main/mcp/detect'
import { McpPool } from '../src/main/mcp/pool'
import { imageOf, PidRegistry } from '../src/main/mcp/process'
import { loadMcpConfig } from '../src/main/mcp/profile'

/**
 * REAL Blender, headless, through the project's own config/mcp.json profile (instance-per-agent, third-party tools off).
 * Skipped when Blender or the add-on is not installed on this machine. Takes ~30-60 s.
 */
const blender = findBlender()
const addon = path.join(process.env['APPDATA'] ?? path.join(homedir(), 'AppData', 'Roaming'), 'freeagent', 'mcp', 'dcc-mcp-blender', 'dcc_mcp_blender', 'blender_bootstrap.py')
const available = !!blender && existsSync(addon)

let dir: string
let pool: McpPool | undefined
afterAll(async () => {
  await pool?.shutdown()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!available)('Blender 5.x vero, senza finestra, un processo per agente', () => {
  // FREEAGENT_BLENDER_N=10 to try the upper end of 5-10 agents.
  const AGENTS = Array.from({ length: Number(process.env['FREEAGENT_BLENDER_N'] ?? 5) }, (_, i) => String.fromCharCode(65 + i))

  it('5 agenti in parallelo, ognuno la sua scena: nessuna interferenza, solo bpy esposto, tutto chiuso alla fine', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'fa-blender-'))
    const { servers, problems } = loadMcpConfig(fileURLToPath(new URL('../config/mcp.json', import.meta.url)))
    expect(problems).toEqual([])
    // The shipped profile caps at 8 processes; every agent here holds its Blender until the end, so allow as many as agents.
    servers.get('blender')!.freeagent.maxInstances = Math.max(servers.get('blender')!.freeagent.maxInstances, AGENTS.length)
    const workDir = (s: string, a: string) => {
      const d = path.join(dir, 'w', s, a)
      mkdirSync(d, { recursive: true })
      return d
    }
    const notes: string[] = []
    pool = new McpPool({ servers, workDir, registry: new PidRegistry(path.join(dir, 'pids.json')), vars: { blenderExe: blender! }, onNote: (a, t) => void notes.push(`${a}: ${t}`) })

    const run = async (agent: string, k: number) => {
      const t0 = Date.now()
      const names = (await pool!.tools('blender', agent)).map((t) => t.name).sort()
      const file = path.join(workDir('blender', agent), 'work.blend')
      const code = [
        'import bpy',
        'bpy.ops.mesh.primitive_cube_add(size=1)',
        'o = bpy.context.active_object',
        `o.name = 'Obj_${agent}'`,
        `o.scale = (${k}, ${k}, ${k})`,
        `bpy.ops.wm.save_as_mainfile(filepath=r'${file}')`,
        "result = sorted(x.name for x in bpy.data.objects if x.name.startswith('Obj_'))"
      ].join('\n')
      const out = JSON.parse(await pool!.call('blender', agent, 'execute_python', { code })) as { success: boolean; context: { result: string } }
      const info = await pool!.call('blender', agent, 'get_blender_info', {})
      return { names, out, file, info, secs: Math.round((Date.now() - t0) / 100) / 10 }
    }

    const t0 = Date.now()
    const results = await Promise.all(AGENTS.map((a, i) => run(a, i + 2)))
    const total = Math.round((Date.now() - t0) / 100) / 10
    const inst = pool.status()[0]!.instances
    const pids = inst.map((i) => i.pid!)
    const ramMB = Math.round(Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process blender | Measure-Object WorkingSet64 -Sum).Sum / 1MB'], { encoding: 'utf8' }).trim().replace(',', '.')))
    console.log(`[blender-real] ${AGENTS.length} instances in parallel: ${total} s total, per agent ${results.map((r) => r.secs).join('/')} s; ${notes.length} notes; Blender RAM ${ramMB} MB total (${Math.round(ramMB / AGENTS.length)} MB each)`)

    for (const [i, r] of results.entries()) {
      // third-party tools are switched off: only the bpy scripting tools reach the agent
      expect(r.names).toEqual(['execute_python', 'get_blender_info'])
      expect(r.out.success).toBe(true)
      // each agent's Blender holds ONLY its own object
      expect(r.out.context.result).toBe(`['Obj_${AGENTS[i]}']`)
      expect(existsSync(r.file)).toBe(true) // saved in its own folder
      expect(r.info).toMatch(/5\.\d/)
    }
    expect(new Set(pids).size).toBe(AGENTS.length) // five different processes
    expect(inst.every((x) => x.state === 'ready' && imageOf(x.pid!)?.toLowerCase() === 'blender.exe')).toBe(true)

    await expect(pool.call('blender', 'A', 'register_tool', {})).rejects.toThrow(/tool "register_tool" is not available on "blender"/)
    await expect(pool.call('blender', 'A', 'load_skill', { skill_name: 'blender-objects' })).rejects.toThrow(/not available/)

    for (const a of AGENTS) await pool.releaseAgent(a)
    await new Promise((r) => setTimeout(r, 1500))
    expect(pids.every((p) => imageOf(p) === undefined)).toBe(true) // every Blender is gone
    expect(pool.status()[0]!.instances).toEqual([])
  }, 240_000)
})
