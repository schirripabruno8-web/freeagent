import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOTS = ['C:\\Program Files\\Blender Foundation', 'C:\\Program Files (x86)\\Blender Foundation']

const version = (dir: string): number[] => (/(\d+(?:\.\d+)*)\s*$/.exec(dir)?.[1] ?? '0').split('.').map(Number)
const newer = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

/** Blender on this PC: FREEAGENT_BLENDER if set, else the newest "Blender x.y" under Program Files. */
export function findBlender(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  list: (p: string) => string[] = (p) => readdirSync(p)
): string | undefined {
  const forced = env['FREEAGENT_BLENDER']
  if (forced && exists(forced)) return forced
  const found: { exe: string; v: number[] }[] = []
  for (const root of ROOTS) {
    let names: string[] = []
    try {
      names = list(root)
    } catch {
      continue
    }
    for (const n of names) {
      const exe = path.win32.join(root, n, 'blender.exe')
      if (/^Blender(\s+\d+(\.\d+)*)?$/.test(n) && exists(exe)) found.push({ exe, v: version(n) })
    }
  }
  return found.sort((a, b) => newer(b.v, a.v))[0]?.exe
}
