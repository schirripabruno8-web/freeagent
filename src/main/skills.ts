import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { ToolDef } from '@contracts/agent'
import type { PonytailMode, Skill } from '@contracts/skills'

const Front = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'lowercase letters, digits and -'),
  description: z.string().min(1).max(2000)
})

/** SKILL.md = YAML frontmatter + instructions. Other frontmatter keys (argument-hint, license, ...) are allowed and ignored. */
export function parseSkill(text: string): Pick<Skill, 'name' | 'description' | 'body'> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''))
  if (!m) throw new Error('missing --- frontmatter')
  const f = Front.parse(parseYaml(m[1]!))
  return { name: f.name, description: f.description.replace(/\s+/g, ' ').trim(), body: m[2]!.trim() }
}

/** Each folder with a SKILL.md is a skill. A broken one is skipped and reported; the first of two with the same name wins. */
export function loadSkills(sources: { dir: string; source: Skill['source'] }[]): { skills: Skill[]; problems: string[] } {
  const skills: Skill[] = []
  const problems: string[] = []
  for (const { dir, source } of sources) {
    if (!existsSync(dir)) continue
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, d.name, 'SKILL.md')
      if (!d.isDirectory() || !existsSync(file)) continue
      try {
        const s = parseSkill(readFileSync(file, 'utf8'))
        if (skills.some((x) => x.name === s.name)) problems.push(`skill "${s.name}" (${source}) ignored: a skill with that name is already loaded`)
        else skills.push({ ...s, source })
      } catch (e) {
        problems.push(`${d.name}/SKILL.md: ${e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') : (e as Error).message}`)
      }
    }
  }
  return { skills, problems }
}

const MAX_BODY = 20_000

/** The model sees only names and descriptions in its first message; this loads the full text when a task matches. */
export function loadSkillTool(skills: Skill[]): ToolDef<{ name: string }> {
  const names = skills.map((s) => s.name)
  return {
    name: 'load_skill',
    description: `Read the full instructions of a skill when the task matches its description. Skills: ${names.join(', ')}`,
    argsHint: '{"name": string}',
    schema: z.object({ name: z.string() }),
    risk: 'read',
    run: async (a) => {
      const s = skills.find((x) => x.name === a.name)
      if (!s) throw new Error(`unknown skill "${a.name}". Available: ${names.join(', ')}`)
      return s.body.length > MAX_BODY ? `${s.body.slice(0, MAX_BODY)}\n[... skill cut at ${MAX_BODY} characters]` : s.body
    }
  }
}

/** ponytail is an always-on rule set, not an on-demand skill: its text goes into every agent's first message. */
export function ponytailPrelude(skills: Skill[], mode: PonytailMode): string {
  const s = skills.find((x) => x.name === 'ponytail')
  if (mode === 'off' || !s) return ''
  return `ACTIVE SKILL, always on: ponytail, level ${mode}. Apply these rules to everything you do, at this level.\n\n${s.body}`
}

/**
 * `/ponytail`, `/ponytail lite|full|ultra`, "stop ponytail", "normal mode" at the START of the task text. What follows is the real task
 * (empty = the text was only a command). `/ponytail` alone means full.
 */
export function parsePonytailCommand(text: string): { mode: PonytailMode; rest: string } | null {
  const off = /^\s*(?:stop ponytail|normal mode)\b\s*([\s\S]*)$/i.exec(text)
  if (off) return { mode: 'off', rest: off[1]!.trim() }
  const on = /^\s*\/ponytail(?:\s+(lite|full|ultra)\b)?\s*([\s\S]*)$/i.exec(text)
  if (on) return { mode: (on[1]?.toLowerCase() as PonytailMode | undefined) ?? 'full', rest: on[2]!.trim() }
  return null
}
