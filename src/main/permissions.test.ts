import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthDecision, ToolCall, ToolDef } from '@contracts/agent'
import type { ApprovalRequest, PermissionMode } from '@contracts/permissions'
import { bashTool } from './bash'
import { makeAuthorizer } from './permissions'
import { createSandbox } from './sandbox'

const pathSchema = z.object({ path: z.string() })
const readT: ToolDef<{ path: string }> = {
  name: 'read', description: '', argsHint: '', schema: pathSchema, risk: 'read', paths: (a) => [a.path], run: async () => ''
}
const writeT: ToolDef<{ path: string }> = {
  name: 'edit', description: '', argsHint: '', schema: pathSchema, risk: 'write', paths: (a) => [a.path],
  preview: async (a) => `DIFF of ${a.path}`, run: async () => ''
}
const brokenEdit: ToolDef<{ path: string }> = {
  ...writeT, preview: async () => { throw new Error('old_string not found') }
}

let base: string
let ws: string
let outside: string
beforeAll(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-perm-')))
  ws = path.join(base, 'work')
  outside = path.join(base, 'secret')
  mkdirSync(ws)
  mkdirSync(outside)
  writeFileSync(path.join(ws, 'a.txt'), 'a')
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

function setup(mode: PermissionMode, answer = true, allowlist: string[] = []) {
  const asked: Omit<ApprovalRequest, 'id'>[] = []
  const authorize = makeAuthorizer({
    cwd: ws,
    sandbox: createSandbox(ws),
    getMode: () => mode,
    allowlist: () => allowlist,
    requestApproval: async (r) => (asked.push(r), answer)
  })
  const run = (def: ToolDef, args: unknown): Promise<AuthDecision> => authorize({ id: '1', tool: def.name, args } as ToolCall, def)
  return { asked, run }
}

describe('makeAuthorizer: modo x strumento x posizione', () => {
  it('readonly: legge dentro senza chiedere, nega modifiche e comandi senza chiedere, fuori chiede', async () => {
    const s = setup('readonly')
    expect(await s.run(readT, { path: 'a.txt' })).toEqual({ allow: true })
    expect(await s.run(writeT, { path: 'a.txt' })).toMatchObject({ allow: false, reason: expect.stringMatching(/read-only/) })
    expect(await s.run(bashTool, { command: 'ls' })).toMatchObject({ allow: false })
    expect(s.asked).toEqual([])
    expect(await s.run(readT, { path: '../secret/k.txt' })).toEqual({ allow: true, outside: true })
    expect(s.asked).toHaveLength(1)
  })

  it('ask: ogni modifica chiede con il diff; sola lettura dentro no', async () => {
    const s = setup('ask')
    expect(await s.run(readT, { path: 'a.txt' })).toEqual({ allow: true })
    expect(s.asked).toHaveLength(0)
    expect(await s.run(writeT, { path: 'a.txt' })).toEqual({ allow: true, outside: false })
    expect(s.asked[0]).toMatchObject({ kind: 'write', tool: 'edit', summary: 'edit a.txt', detail: 'DIFF of a.txt', outside: false })
  })

  it('auto: modifica dentro passa senza chiedere; fuori chiede e il consenso vale solo per quella chiamata', async () => {
    const s = setup('auto')
    expect(await s.run(writeT, { path: 'sub/new.txt' })).toEqual({ allow: true })
    expect(s.asked).toHaveLength(0)
    expect(await s.run(writeT, { path: '../secret/x.txt' })).toEqual({ allow: true, outside: true })
    expect(s.asked[0]).toMatchObject({ kind: 'outside', outside: true })
  })

  it('bash: chiede sempre (anche in auto) con il comando; la allowlist lo lascia passare; una concatenazione no', async () => {
    const s = setup('auto', true, ['git status', 'npm test'])
    expect(await s.run(bashTool, { command: 'git status -s' })).toEqual({ allow: true })
    expect(s.asked).toHaveLength(0)
    await s.run(bashTool, { command: 'git status; rm -rf x' })
    await s.run(bashTool, { command: 'npm run build' })
    expect(s.asked.map((r) => r.summary)).toEqual(['bash: git status; rm -rf x', 'bash: npm run build'])
    expect(s.asked[0]).toMatchObject({ kind: 'bash', detail: 'git status; rm -rf x', outside: false })
  })

  it('full: bash e modifiche dentro passano senza chiedere; fuori chiede; i percorsi vietati restano negati', async () => {
    const s = setup('full')
    expect(await s.run(bashTool, { command: 'rm -rf node_modules' })).toEqual({ allow: true })
    expect(await s.run(writeT, { path: 'a.txt' })).toEqual({ allow: true })
    expect(s.asked).toHaveLength(0)
    expect(await s.run(writeT, { path: '../secret/x.txt' })).toEqual({ allow: true, outside: true })
    expect(s.asked).toHaveLength(1)
    expect(await s.run(writeT, { path: 'a.txt:ads' })).toMatchObject({ allow: false })
  })

  it('il riepilogo di bash usa solo la prima riga', async () => {
    const s = setup('ask')
    await s.run(bashTool, { command: 'echo uno\necho due' })
    expect(s.asked[0]!.summary).toBe('bash: echo uno')
    expect(s.asked[0]!.detail).toBe('echo uno\necho due')
  })
})

describe('makeAuthorizer: rifiuti e casi di sicurezza', () => {
  it('se l\'utente nega, la chiamata e\' negata con un motivo', async () => {
    const s = setup('ask', false)
    expect(await s.run(writeT, { path: 'a.txt' })).toEqual({ allow: false, reason: 'the user declined' })
  })

  it('percorso vietato: negato SENZA disturbare l\'utente, in qualsiasi modo', async () => {
    for (const mode of ['ask', 'auto'] as const) {
      const s = setup(mode)
      for (const p of ['a.txt:ads', 'CON', 'a.txt.', '\\\\?\\C:\\Windows']) {
        const d = await s.run(writeT, { path: p })
        expect(d, p).toMatchObject({ allow: false, reason: expect.stringMatching(/path refused/) })
      }
      expect(s.asked).toEqual([])
    }
  })

  it('anteprima che fallisce (es. old_string non trovata): errore al modello, nessuna domanda all\'utente', async () => {
    const s = setup('ask')
    expect(await s.run(brokenEdit, { path: 'a.txt' })).toEqual({ allow: false, reason: 'old_string not found' })
    expect(s.asked).toEqual([])
  })

  it('una junction dentro la cartella che punta fuori conta come FUORI anche in auto', async () => {
    try {
      symlinkSync(outside, path.join(ws, 'link'), 'junction')
    } catch {
      return
    }
    const s = setup('auto')
    expect(await s.run(writeT, { path: 'link/x.txt' })).toEqual({ allow: true, outside: true })
    expect(s.asked[0]).toMatchObject({ kind: 'outside', outside: true })
  })

  it('argomenti non validi: negato', async () => {
    expect(await setup('auto').run(writeT, { path: 5 })).toEqual({ allow: false, reason: 'invalid arguments' })
  })

  it('l\'anteprima non puo\' modificare nulla', async () => {
    let called: Error | undefined
    const probe: ToolDef<{ path: string }> = {
      ...writeT,
      preview: async (_a, ctx) => {
        try {
          await ctx.checkpoint([])
        } catch (e) {
          called = e as Error
        }
        return ''
      }
    }
    await setup('ask').run(probe, { path: 'a.txt' })
    expect(called?.message).toMatch(/must not modify/)
  })
})
