import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSkills, loadSkillTool, parsePonytailCommand, parseSkill, ponytailPrelude } from './skills'

let dir: string
beforeEach(() => void (dir = mkdtempSync(path.join(tmpdir(), 'fa-skills-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const put = (folder: string, content: string, base = dir) => {
  mkdirSync(path.join(base, folder), { recursive: true })
  writeFileSync(path.join(base, folder, 'SKILL.md'), content)
}

describe('parseSkill', () => {
  it('frontmatter semplice, descrizione piegata (">") e chiavi extra ignorate', () => {
    const s = parseSkill('---\nname: demo\ndescription: >\n  Una riga\n  su due righe.\nargument-hint: "[x]"\nlicense: MIT\n---\n\nCorpo\ndelle regole\n')
    expect(s).toEqual({ name: 'demo', description: 'Una riga su due righe.', body: 'Corpo\ndelle regole' })
  })

  it('accetta CRLF e BOM; rifiuta frontmatter mancante, nome non valido, descrizione vuota', () => {
    expect(parseSkill('﻿---\r\nname: crlf\r\ndescription: ok\r\n---\r\ntesto').name).toBe('crlf')
    expect(() => parseSkill('niente frontmatter')).toThrow(/frontmatter/)
    expect(() => parseSkill('---\nname: Bad Name\ndescription: x\n---\nt')).toThrow()
    expect(() => parseSkill('---\nname: ok\n---\nt')).toThrow()
  })
})

describe('ponytail importata dal repo originale', () => {
  const skills = loadSkills([{ dir: fileURLToPath(new URL('../../skills', import.meta.url)), source: 'bundled' }])

  it('skills/ponytail/SKILL.md si legge, con licenza MIT e origine annotata', () => {
    expect(skills.problems).toEqual([])
    const p = skills.skills.find((s) => s.name === 'ponytail')!
    expect(p.description).toMatch(/Lazy senior dev mode/)
    expect(p.body).toMatch(/## Levels/)
    expect(p.body).toMatch(/\*\*ultra\*\*/)
  })

  it('il testo entra nel prelude solo se attiva, con il livello', () => {
    expect(ponytailPrelude(skills.skills, 'off')).toBe('')
    const u = ponytailPrelude(skills.skills, 'ultra')
    expect(u).toMatch(/^ACTIVE SKILL, always on: ponytail, level ultra\./)
    expect(u).toContain('The best code is the code never written')
    expect(ponytailPrelude([], 'full')).toBe('') // no skill installed: nothing to inject
  })
})

describe('loadSkills', () => {
  it('legge le cartelle con SKILL.md; salta le rotte e dice perche; il primo nome vince', () => {
    const user = path.join(dir, 'user')
    put('good', '---\nname: good\ndescription: ok\n---\nbody')
    put('broken', '---\nname: BAD\ndescription: x\n---\nbody')
    put('nomd-dir', '---\nname: x\n---\n')
    mkdirSync(path.join(dir, 'empty'))
    put('good2', '---\nname: good\ndescription: duplicate\n---\nother', dir)
    put('mine', '---\nname: mine\ndescription: mine\n---\nm', user)
    const r = loadSkills([{ dir, source: 'bundled' }, { dir: user, source: 'user' }, { dir: path.join(dir, 'missing'), source: 'user' }])
    expect(r.skills.map((s) => `${s.name}:${s.source}`).sort()).toEqual(['good:bundled', 'mine:user'])
    expect(r.problems.join('\n')).toMatch(/broken\/SKILL\.md/)
    expect(r.problems.join('\n')).toMatch(/nomd-dir\/SKILL\.md/)
    expect(r.problems.join('\n')).toMatch(/skill "good".*already loaded/)
  })
})

describe('loadSkillTool', () => {
  const skills = [{ name: 'a', description: 'd', body: 'x'.repeat(25_000), source: 'bundled' as const }, { name: 'b', description: 'd', body: 'corpo b', source: 'user' as const }]
  const tool = loadSkillTool(skills)

  it('restituisce il corpo, tagliato se enorme; nome sconosciuto = errore con l\'elenco', async () => {
    expect(await tool.run({ name: 'b' }, {} as never)).toBe('corpo b')
    expect(await tool.run({ name: 'a' }, {} as never)).toMatch(/\[\.\.\. skill cut at 20000 characters\]$/)
    await expect(tool.run({ name: 'zzz' }, {} as never)).rejects.toThrow(/unknown skill "zzz"\. Available: a, b/)
    expect(tool.risk).toBe('read')
    expect(tool.paths).toBeUndefined() // reads nothing from disk by a model-supplied path
  })
})

describe('parsePonytailCommand', () => {
  it('livelli, default full, spegnimento, e il testo che segue e\' il compito', () => {
    expect(parsePonytailCommand('/ponytail')).toEqual({ mode: 'full', rest: '' })
    expect(parsePonytailCommand('/ponytail ultra')).toEqual({ mode: 'ultra', rest: '' })
    expect(parsePonytailCommand('  /PONYTAIL lite  ')).toEqual({ mode: 'lite', rest: '' })
    expect(parsePonytailCommand('/ponytail ultra rifai il parser')).toEqual({ mode: 'ultra', rest: 'rifai il parser' })
    expect(parsePonytailCommand('/ponytail fai il parser')).toEqual({ mode: 'full', rest: 'fai il parser' })
    expect(parsePonytailCommand('stop ponytail')).toEqual({ mode: 'off', rest: '' })
    expect(parsePonytailCommand('Normal mode ora scrivi un test')).toEqual({ mode: 'off', rest: 'ora scrivi un test' })
  })

  it('non scambia il testo normale per un comando', () => {
    for (const t of ['scrivi un parser', 'usa /ponytail ultra', 'ponytail ultra', 'abnormal mode', '']) expect(parsePonytailCommand(t), t).toBeNull()
  })
})
