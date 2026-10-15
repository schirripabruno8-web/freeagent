import { z } from 'zod'

/** A SKILL.md folder, Claude Code compatible: frontmatter with name + description, then the instructions. */
export interface Skill {
  name: string
  description: string
  /** The instructions, without the frontmatter. */
  body: string
  /** bundled = shipped in skills/, user = %APPDATA%/freeagent/skills. */
  source: 'bundled' | 'user'
}

/** What the UI shows: never the body. */
export interface SkillInfo {
  name: string
  description: string
  source: Skill['source']
}

export const PonytailModeSchema = z.enum(['off', 'lite', 'full', 'ultra'])
export type PonytailMode = z.infer<typeof PonytailModeSchema>
