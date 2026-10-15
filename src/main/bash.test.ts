import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bashTool, findBash, runBash } from './bash'

let ws: string
beforeAll(() => {
  ws = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-bash-')))
})
afterAll(() => rmSync(ws, { recursive: true, force: true }))

describe.skipIf(!findBash())('runBash (Git Bash vero)', () => {
  it('stdout, stderr uniti, codice di uscita', async () => {
    expect(await runBash('echo ciao', ws, 10_000)).toContain('ciao')
    expect(await runBash('echo err 1>&2', ws, 10_000)).toContain('err')
    expect(await runBash('echo prima; exit 3', ws, 10_000)).toMatch(/^exit code 3\nprima/)
    expect(await runBash('true', ws, 10_000)).toBe('(no output)')
  })

  it('parte dalla cartella di lavoro', async () => {
    expect((await runBash('pwd', ws, 10_000)).toLowerCase()).toContain(path.basename(ws).toLowerCase())
  })

  it('timeout: uccide il comando e restituisce una nota', async () => {
    const t0 = Date.now()
    const out = await runBash('sleep 30', ws, 1000)
    expect(out).toMatch(/^\[timed out after 1s and was killed\]/)
    expect(Date.now() - t0).toBeLessThan(8000)
  })

  it('Stop dell\'utente: uccide il comando', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 300)
    expect(await runBash('sleep 30', ws, 60_000, ac.signal)).toMatch(/^\[stopped by the user\]/)
  })

  it('stdin chiuso: un comando che aspetta input non resta appeso', async () => {
    const t0 = Date.now()
    await runBash('read x; echo fatto', ws, 20_000)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('output enorme tagliato', async () => {
    const out = await runBash('yes x | head -c 400000', ws, 20_000)
    expect(out.length).toBeLessThan(210_000)
    expect(out).toContain('[output cut]')
  })
})

describe('bashTool', () => {
  it('rischio exec, nessun percorso dichiarato (chiede sempre), anteprima = il comando', async () => {
    expect(bashTool.risk).toBe('exec')
    expect(bashTool.paths).toBeUndefined()
    expect(await bashTool.preview!({ command: 'npm test' }, {} as never)).toBe('npm test')
  })

  it('schema: comando non vuoto, timeout entro i limiti', () => {
    expect(bashTool.schema.safeParse({ command: '' }).success).toBe(false)
    expect(bashTool.schema.safeParse({ command: 'ls', timeout_ms: 10 }).success).toBe(false)
    expect(bashTool.schema.safeParse({ command: 'ls', timeout_ms: 500_000 }).success).toBe(false)
    expect(bashTool.schema.safeParse({ command: 'ls', timeout_ms: 5000 }).success).toBe(true)
  })
})
