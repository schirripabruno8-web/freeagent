import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { SelectorsSchema, type SelectorsConfig } from '../../../contracts/selectors'

export function loadSelectors(file: string): SelectorsConfig {
  try {
    return SelectorsSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch (err) {
    const why = err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err)
    throw new Error(`Selettori non validi in ${file}:\n${why}`)
  }
}
