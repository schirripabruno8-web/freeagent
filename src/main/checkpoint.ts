import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CheckpointInfo } from '@contracts/permissions'

interface Entry {
  path: string
  /** Did the file exist before the change? If not, undoing deletes it. */
  existed: boolean
}
interface Manifest {
  id: string
  ts: number
  tool: string
  entries: Entry[]
}

const MAX_FILE = 200 * 1024 * 1024

/**
 * Snapshots files BEFORE a change so it can be undone. One folder per checkpoint: manifest.json + the old bytes.
 * bash changes cannot be checkpointed (the app cannot know what a command touches): only write/edit are covered.
 */
export class CheckpointStore {
  private seq: number | undefined

  constructor(private readonly dir: string) {}

  private async nextId(): Promise<string> {
    if (this.seq === undefined) {
      const ids = await this.ids()
      this.seq = ids.length ? Number(ids[ids.length - 1]) : 0
    }
    return String(++this.seq).padStart(6, '0')
  }

  private async ids(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((n) => /^\d{6}$/.test(n)).sort()
    } catch {
      return []
    }
  }

  private async manifest(id: string): Promise<Manifest> {
    return JSON.parse(await readFile(path.join(this.dir, id, 'manifest.json'), 'utf8')) as Manifest
  }

  async create(tool: string, files: string[]): Promise<string> {
    const id = await this.nextId()
    const folder = path.join(this.dir, id)
    await mkdir(folder, { recursive: true })
    const entries: Entry[] = []
    for (const [i, file] of files.entries()) {
      let st
      try {
        st = await stat(file)
      } catch {
        entries.push({ path: file, existed: false })
        continue
      }
      if (!st.isFile()) throw new Error(`cannot checkpoint, not a regular file: ${file}`)
      if (st.size > MAX_FILE) throw new Error(`cannot checkpoint, file too large (${st.size} bytes): ${file}`)
      await copyFile(file, path.join(folder, `${i}.bin`))
      entries.push({ path: file, existed: true })
    }
    const m: Manifest = { id, ts: Date.now(), tool, entries }
    await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(m)) // written last: a half-made checkpoint has no manifest and is ignored
    return id
  }

  async list(): Promise<CheckpointInfo[]> {
    const out: CheckpointInfo[] = []
    for (const id of await this.ids()) {
      try {
        const m = await this.manifest(id)
        out.push({ id, ts: m.ts, tool: m.tool, files: m.entries.map((e) => e.path) })
      } catch {
        /* incomplete checkpoint */
      }
    }
    return out
  }

  /** Rewinds every change from the newest checkpoint back to and including `id`, then forgets those checkpoints. */
  async restoreTo(id: string): Promise<{ restored: string[] }> {
    const all = (await this.ids()).filter((n) => n >= id)
    if (!all.includes(id)) throw new Error(`unknown checkpoint ${id}`)
    const restored = new Set<string>()
    for (const cid of all.reverse()) {
      const m = await this.manifest(cid)
      for (const [i, e] of m.entries.entries()) {
        if (e.existed) {
          await mkdir(path.dirname(e.path), { recursive: true })
          await copyFile(path.join(this.dir, cid, `${i}.bin`), e.path)
        } else await rm(e.path, { force: true })
        restored.add(e.path)
      }
      await rm(path.join(this.dir, cid), { recursive: true, force: true })
    }
    return { restored: [...restored] }
  }
}

/** Deletes run folders under `root` older than `maxAgeMs` (each app run keeps its own checkpoints). */
export async function pruneRuns(root: string, maxAgeMs: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  for (const n of names) {
    const p = path.join(root, n)
    try {
      if (Date.now() - (await stat(p)).mtimeMs > maxAgeMs) await rm(p, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}
