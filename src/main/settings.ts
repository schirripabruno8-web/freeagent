import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { PonytailModeSchema } from '@contracts/skills'

export const ModeSchema = z.enum(['readonly', 'ask', 'auto', 'full'])

// Each field falls back on its own, so one bad value does not reset the others.
const Schema = z.object({
  mode: ModeSchema.catch('ask'),
  ponytail: PonytailModeSchema.catch('full'),
  /** MCP servers the user switched off (bundled or added by the user): they stay configured but no agent sees them. */
  mcpDisabled: z.array(z.string()).catch([])
})
export type Settings = z.infer<typeof Schema>

/** Defaults are the cautious ones: ask before changing anything, ponytail on at its default level. */
export function loadSettings(file: string): Settings {
  try {
    return Schema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return Schema.parse({})
  }
}

export function saveSettings(file: string, s: Settings): void {
  writeFileSync(file, JSON.stringify(s))
}
