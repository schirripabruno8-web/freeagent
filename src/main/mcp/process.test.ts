import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { imageOf, killTree, PidRegistry, startProcess } from './process'

const node = process.execPath
const js = (code: string) => ['-e', code]
const alive = (pid: number) => imageOf(pid) !== undefined

let dir: string
beforeEach(() => void (dir = mkdtempSync(path.join(tmpdir(), 'fa-proc-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('startProcess', () => {
  it('pronto quando stampa il motivo: restituisce il gruppo catturato; stop() lo ferma', async () => {
    const p = startProcess({ command: node, args: js("console.log('boot'); setTimeout(() => console.log('READY 4711'), 100); setInterval(() => {}, 1000)"), ready: /READY (\d+)/, timeoutMs: 10_000, label: 'fake' })
    expect(await p.ready).toBe('4711')
    expect(alive(p.pid)).toBe(true)
    await p.stop()
    expect(alive(p.pid)).toBe(false)
  })

  it('senza motivo e\' subito pronto', async () => {
    const p = startProcess({ command: node, args: js('setInterval(() => {}, 1000)'), timeoutMs: 10_000, label: 'plain' })
    expect(await p.ready).toBe('')
    await p.stop()
  })

  it('esce prima di essere pronto: errore con il codice e le ultime righe di output', async () => {
    const p = startProcess({ command: node, args: js("console.error('boom: missing module'); process.exit(3)"), ready: /READY/, timeoutMs: 10_000, label: 'crashy' })
    await expect(p.ready).rejects.toThrow(/exited \(code 3\) before it was ready[\s\S]*boom: missing module/)
  })

  it('non diventa mai pronto: scade, dice cosa ha stampato e uccide il processo', async () => {
    const p = startProcess({ command: node, args: js("console.log('still loading'); setInterval(() => {}, 1000)"), ready: /READY/, timeoutMs: 1000, label: 'slow' })
    await expect(p.ready).rejects.toThrow(/was not ready after 1 s[\s\S]*still loading/)
    await wait(1500)
    expect(alive(p.pid)).toBe(false)
  })

  it('comando inesistente: errore chiaro, nessun crash', async () => {
    const p = startProcess({ command: path.join(dir, 'nope.exe'), args: [], ready: /x/, timeoutMs: 5000, label: 'nope' })
    await expect(p.ready).rejects.toThrow(/cannot start/)
    await p.stop()
  })

  it('stop() uccide anche i processi figli', async () => {
    const code = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); console.log('CHILD ' + c.pid); setInterval(() => {}, 1000)"
    const p = startProcess({ command: node, args: js(code), ready: /CHILD (\d+)/, timeoutMs: 10_000, label: 'tree' })
    const child = Number(await p.ready)
    expect(alive(child)).toBe(true)
    await p.stop()
    await wait(300)
    expect(alive(child)).toBe(false)
  })
})

describe('PidRegistry', () => {
  it('uccide gli orfani con la stessa immagine, ignora un pid riusato da un altro programma, e svuota il registro', () => {
    const file = path.join(dir, 'pids.json')
    const killed: number[] = []
    const reg = new PidRegistry(file, (pid) => (pid === 100 ? 'blender.exe' : pid === 200 ? 'chrome.exe' : undefined), (pid) => void killed.push(pid))
    reg.add(100, 'blender.exe', 'a')
    reg.add(200, 'blender.exe', 'b') // this pid now belongs to chrome: must NOT be killed
    reg.add(300, 'blender.exe', 'c') // already gone
    expect(reg.cleanupOrphans()).toBe(1)
    expect(killed).toEqual([100])
    expect(reg.cleanupOrphans()).toBe(0) // cleared
  })

  it('remove() toglie la voce; un file rotto non fa nulla', () => {
    const file = path.join(dir, 'pids.json')
    const killed: number[] = []
    const reg = new PidRegistry(file, () => 'x.exe', (p) => void killed.push(p))
    reg.add(1, 'x.exe', 'a')
    reg.remove(1)
    expect(reg.cleanupOrphans()).toBe(0)
    expect(new PidRegistry(path.join(dir, 'missing', 'p.json')).cleanupOrphans()).toBe(0)
  })

  it('vero: un processo lasciato dopo un crash dell\'app viene ucciso al prossimo avvio', async () => {
    const file = path.join(dir, 'pids.json')
    const p = startProcess({ command: node, args: js('setInterval(() => {}, 1000)'), timeoutMs: 10_000, label: 'orphan', registry: new PidRegistry(file) })
    await p.ready
    expect(alive(p.pid)).toBe(true)
    // the app "crashes": nobody calls stop(). A new app instance reads the same file:
    expect(new PidRegistry(file).cleanupOrphans()).toBe(1)
    await wait(300)
    expect(alive(p.pid)).toBe(false)
    killTree(p.pid)
  })
})
