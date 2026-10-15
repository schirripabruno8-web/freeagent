import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface Started {
  pid: number
  /** The regex's first capture group once the process printed it ('' right away when there is no pattern). Rejects on timeout, early exit, spawn error. */
  ready: Promise<string>
  /** The last part of the output, for error messages. */
  tail(): string
  /** Kills the process tree and waits for it to go. */
  stop(): Promise<void>
}

export function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** The image name of a running pid, or undefined if no such process. */
export function imageOf(pid: number): string | undefined {
  try {
    if (process.platform !== 'win32') return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim() || undefined
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    const m = /^"([^"]+)","(\d+)"/m.exec(out)
    return m && Number(m[2]) === pid ? m[1] : undefined
  } catch {
    return undefined
  }
}

interface Entry {
  pid: number
  image: string
  label: string
  startedAt: number
}

/**
 * Remembers the processes the app started. If the app dies without closing them (crash, power loss), the next start kills the leftovers:
 * a Blender nobody can reach still eats RAM. A pid is only killed if it STILL has the image name we recorded (pids get reused).
 */
export class PidRegistry {
  constructor(
    private readonly file: string,
    private readonly probe: (pid: number) => string | undefined = imageOf,
    private readonly kill: (pid: number) => void = killTree
  ) {}

  private read(): Entry[] {
    try {
      const v: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(v) ? (v as Entry[]) : []
    } catch {
      return []
    }
  }

  private write(entries: Entry[]): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(entries))
    } catch {
      /* the registry is a safety net, not a requirement */
    }
  }

  add(pid: number, image: string, label: string): void {
    this.write([...this.read().filter((e) => e.pid !== pid), { pid, image, label, startedAt: Date.now() }])
  }

  remove(pid: number): void {
    this.write(this.read().filter((e) => e.pid !== pid))
  }

  /** Kills the recorded processes that are still alive with the same image; forgets all entries. Returns how many it killed. */
  cleanupOrphans(): number {
    let n = 0
    for (const e of this.read()) {
      const img = this.probe(e.pid)
      if (img && img.toLowerCase() === e.image.toLowerCase()) {
        this.kill(e.pid)
        n++
      }
    }
    this.write([])
    return n
  }
}

export function startProcess(o: {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  ready?: RegExp
  timeoutMs: number
  registry?: PidRegistry
  label: string
}): Started {
  const child = spawn(o.command, o.args, { cwd: o.cwd, env: { ...process.env, ...o.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let buf = ''
  let done = false
  let exited = child.exitCode !== null
  const exitWaiters: (() => void)[] = []
  const pid = child.pid ?? -1
  if (child.pid && o.registry) o.registry.add(child.pid, path.basename(o.command), o.label)

  const tail = (): string => buf.slice(-1500).trim()
  let settle!: { ok(v: string): void; fail(e: Error): void }
  const ready = new Promise<string>((resolve, reject) => (settle = { ok: resolve, fail: reject }))
  ready.catch(() => undefined) // a caller that never awaits it must not crash the app

  const finish = (err?: Error, value = ''): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    if (err) settle.fail(err)
    else settle.ok(value)
  }
  const timer = setTimeout(() => {
    finish(new Error(`"${o.label}" was not ready after ${Math.round(o.timeoutMs / 1000)} s.\n${tail()}`))
    void stop()
  }, o.timeoutMs)

  const take = (d: Buffer): void => {
    buf = (buf + d.toString('utf8')).slice(-16_000)
    if (o.ready && !done) {
      const m = o.ready.exec(buf)
      if (m) finish(undefined, m[1] ?? '')
    }
  }
  child.stdout.on('data', take)
  child.stderr.on('data', take)
  child.on('error', (e) => finish(new Error(`cannot start "${o.command}": ${e.message}`)))
  child.on('exit', (code) => {
    exited = true
    if (child.pid) o.registry?.remove(child.pid)
    finish(new Error(`"${o.label}" exited (code ${code}) before it was ready.\n${tail()}`))
    for (const w of exitWaiters.splice(0)) w()
  })
  if (!o.ready) finish(undefined, '')

  async function stop(): Promise<void> {
    if (exited || !child.pid) return
    killTree(child.pid)
    await new Promise<void>((resolve) => {
      exitWaiters.push(resolve)
      setTimeout(resolve, 5000)
    })
  }

  return { pid, ready, tail, stop }
}
