import { readFileSync } from 'node:fs'
import { ModelEntrySchema, type ModelEntry } from '@contracts/models'

/** Reads config/models.json. A bad row is skipped (and reported), so one typo does not empty the whole list. */
export function loadModels(file: string): { models: ModelEntry[]; skipped: number } {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`)
  }
  if (!Array.isArray(raw)) throw new Error(`${file} must be a JSON array`)
  const models: ModelEntry[] = []
  let skipped = 0
  for (const row of raw) {
    const r = ModelEntrySchema.safeParse(row)
    if (r.success) models.push(r.data)
    else skipped++
  }
  return { models, skipped }
}
