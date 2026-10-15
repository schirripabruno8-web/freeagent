import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { Sandbox } from '@contracts/permissions'

const WIN = process.platform === 'win32'
// Windows device names, with or without an extension (CON, nul.txt, COM1...).
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

const lexists = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Reasons a path string is refused outright, before touching the disk. Windows rules only matter on Windows. */
function forbidden(p: string): string | undefined {
  if (p.includes('\0')) return 'NUL byte in path'
  if (!WIN) return undefined
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return 'device/extended-length path prefix (\\\\?\\ or \\\\.\\)'
  const rest = p.replace(/^[A-Za-z]:/, '')
  if (rest.includes(':')) return 'colon in path (alternate data stream)'
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === '.' || seg === '..') continue
    if (/[*?"<>|]/.test(seg)) return `invalid character in "${seg}"`
    if (/[. ]$/.test(seg)) return `"${seg}" ends with a dot or space (Windows strips it)`
    if (DEVICE.test(seg)) return `reserved device name "${seg}"`
  }
  return undefined
}

/** Real path of `abs`: symlinks/junctions/8.3 names resolved on the longest existing prefix, the missing tail appended. */
function realOf(abs: string): string {
  let cur = abs
  const rest: string[] = []
  while (!lexists(cur)) {
    const parent = path.dirname(cur)
    if (parent === cur) break
    rest.unshift(path.basename(cur))
    cur = parent
  }
  try {
    return path.join(realpathSync.native(cur), ...rest)
  } catch {
    throw new Error(`cannot resolve "${abs}" (dangling link or missing drive)`)
  }
}

const fold = (p: string): string => (WIN ? p.toLowerCase() : p)

function isInside(root: string, target: string): boolean {
  const rel = path.relative(fold(root), fold(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

// shortcut: check-then-use race (a path can be swapped for a link after classify), narrowed by returning and using the REAL path;
// upgrade: open files by handle with O_NOFOLLOW-style checks if the agent ever runs next to untrusted local processes.
export function createSandbox(workspace: string): Sandbox {
  const root = realpathSync.native(path.resolve(workspace))
  const classify: Sandbox['classify'] = (p) => {
    const why = forbidden(p)
    if (why) return { ok: false, reason: why }
    try {
      const abs = realOf(path.resolve(root, p))
      return { ok: true, abs, inside: isInside(root, abs) }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }
  return {
    classify,
    resolve(p, allowOutside) {
      const c = classify(p)
      if (!c.ok) throw new Error(`path refused: ${c.reason}`)
      if (!c.inside && !allowOutside) throw new Error(`path is outside the workspace: ${p}`)
      return c.abs
    }
  }
}
