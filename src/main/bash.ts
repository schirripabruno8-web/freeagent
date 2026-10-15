import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import type { ToolDef } from '@contracts/agent'

const OUT_CAP = 200_000

/** Git Bash on Windows. FREEAGENT_BASH overrides; anything else is not guessed. */
export function findBash(): string | undefined {
  const candidates = [
    process.env['FREEAGENT_BASH'],
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env['LOCALAPPDATA'] && `${process.env['LOCALAPPDATA']}\\Programs\\Git\\bin\\bash.exe`,
    process.platform === 'win32' ? undefined : '/bin/bash'
  ]
  return candidates.find((c): c is string => !!c && existsSync(c))
}

export function runBash(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const bash = findBash()
  if (!bash) return Promise.reject(new Error('bash not found: install Git for Windows or set FREEAGENT_BASH to bash.exe'))
  return new Promise((resolve) => {
    // stdin is closed on purpose: a command that waits for input must fail, not hang the agent
    const child = spawn(bash, ['-c', command], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let dropped = false
    let why = ''
    const take = (b: Buffer): void => {
      if (out.length < OUT_CAP) out += b.toString('utf8')
      else dropped = true
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const kill = (reason: string): void => {
      why ||= reason
      if (child.pid === undefined) return
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }
    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)}s and was killed`), timeoutMs)
    const onAbort = (): void => kill('stopped by the user')
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (code: number | null): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const body = out.slice(0, OUT_CAP) + (dropped ? '\n[output cut]' : '')
      if (why) resolve(`[${why}]\n${body}`)
      else resolve(code === 0 ? body || '(no output)' : `exit code ${code}\n${body}`)
    }
    child.on('error', (e) => {
      out += String(e)
      done(null)
    })
    child.on('close', done)
  })
}

export const bashTool: ToolDef<{ command: string; timeout_ms?: number }> = {
  name: 'bash',
  description: 'Run one bash command in the workspace (Git Bash). Needs the user\'s approval unless it is on their allowlist.',
  argsHint: '{"command": string, "timeout_ms"?: number (1000-120000, default 30000)}',
  schema: z.object({ command: z.string().min(1).max(10_000), timeout_ms: z.number().int().min(1000).max(120_000).optional() }),
  risk: 'exec',
  preview: async (a) => a.command,
  run: (a, ctx) => runBash(a.command, ctx.cwd, a.timeout_ms ?? 30_000, ctx.signal)
}
