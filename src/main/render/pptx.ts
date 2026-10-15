import { spawn } from 'node:child_process'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Exports the slides of a presentation as PNG with PowerPoint itself (COM, no window), so what the agent looks at is what PowerPoint draws.
 * Works on a COPY of the file (the user may have the original open) and never closes a PowerPoint the user was already running.
 * Parameters travel in environment variables, never inside the script text: a file name cannot inject commands.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$src = $env:FA_SRC; $out = $env:FA_OUT; $w = [int]$env:FA_W; $max = [int]$env:FA_MAX
$had = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$app = $null; $pres = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $pres = $app.Presentations.Open($src, -1, 0, 0)
  $sw = $pres.PageSetup.SlideWidth; $sh = $pres.PageSetup.SlideHeight
  $h = [int][math]::Round($w * $sh / $sw)
  $n = $pres.Slides.Count
  $m = [math]::Min($n, $max)
  for ($i = 1; $i -le $m; $i++) {
    $pres.Slides.Item($i).Export((Join-Path $out ('slide-{0:D2}.png' -f $i)), 'PNG', $w, $h)
  }
  Write-Output ('FA_RESULT {"slides":' + $n + ',"exported":' + $m + ',"width":' + $w + ',"height":' + $h + '}')
} finally {
  if ($pres) { try { $pres.Close() } catch {} }
  if ($app -and -not $had) { try { $app.Quit() } catch {} }
  [System.GC]::Collect()
}
`

export interface SlideExport {
  files: string[]
  slides: number
  width: number
  height: number
}

export const PPTX_EXT = /\.(pptx|ppt|pps|ppsx|pptm|odp)$/i

export async function exportSlides(src: string, outDir: string, o: { width?: number; maxSlides?: number; timeoutMs?: number } = {}): Promise<SlideExport> {
  const { width = 1280, maxSlides = 30, timeoutMs = 120_000 } = o
  await mkdir(outDir, { recursive: true })
  for (const f of await readdir(outDir)) if (/^slide-\d+\.png$/i.test(f)) await rm(join(outDir, f), { force: true }) // no stale slides from an older version
  const tmpDir = join(tmpdir(), `fa-render-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(tmpDir, { recursive: true })
  const copy = join(tmpDir, `deck${(/\.[a-z0-9]+$/i.exec(src) ?? ['.pptx'])[0]}`)
  await copyFile(src, copy)
  try {
    const stdout = await runPowerShell(SCRIPT, { FA_SRC: copy, FA_OUT: outDir, FA_W: String(width), FA_MAX: String(maxSlides) }, timeoutMs)
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('FA_RESULT '))
    if (!line) throw new Error('PowerPoint did not report a result')
    const r = JSON.parse(line.slice('FA_RESULT '.length)) as { slides: number; exported: number; width: number; height: number }
    const files = (await readdir(outDir)).filter((f) => /^slide-\d+\.png$/i.test(f)).sort().map((f) => join(outDir, f))
    if (files.length !== r.exported) throw new Error(`PowerPoint exported ${files.length} of ${r.exported} slides`)
    return { files, slides: r.slides, width: r.width, height: r.height }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

function runPowerShell(script: string, env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    const timer = setTimeout(() => {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      reject(new Error(`PowerPoint did not answer within ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.on('error', (e) => (clearTimeout(timer), reject(e)))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`PowerPoint export failed (${code}): ${(err || out).replace(/\s+/g, ' ').trim().slice(0, 400)}`))
    })
  })
}
