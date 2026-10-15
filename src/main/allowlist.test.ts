import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAllowlisted, readAllowlist, simpleTokens } from './allowlist'

describe('simpleTokens', () => {
  it('parole semplici e virgolette', () => {
    expect(simpleTokens('git status')).toEqual(['git', 'status'])
    expect(simpleTokens('git log --format="%h %s" -n 3')).toEqual(['git', 'log', '--format=%h %s', '-n', '3'])
    expect(simpleTokens("echo 'a $b `c`'")).toEqual(['echo', 'a $b `c`']) // literal inside single quotes
  })

  it('rifiuta tutto cio che concatena, redirige, sostituisce, espande o fa escape', () => {
    for (const c of [
      'git status; rm -rf x',
      'git status && rm x',
      'git status || x',
      'git status | cat',
      'git status > out.txt',
      'cat < in.txt',
      'echo $(whoami)',
      'echo `whoami`',
      'echo $HOME',
      'echo "$HOME"',
      'echo "`x`"',
      'echo "a\\b"',
      'ls *',
      'ls ~',
      'git status & x',
      'echo a\nrm x',
      'echo a # b',
      '(ls)',
      'echo {a,b}',
      'echo "unclosed',
      'echo \\x',
      ''
    ]) expect(simpleTokens(c), JSON.stringify(c)).toBeNull()
  })
})

describe('isAllowlisted', () => {
  const list = ['git status', 'npm test', 'ls']

  it('prefisso parola per parola, argomenti extra permessi', () => {
    expect(isAllowlisted('git status', list)).toBe(true)
    expect(isAllowlisted('git status -s', list)).toBe(true)
    expect(isAllowlisted('npm test', list)).toBe(true)
    expect(isAllowlisted('ls -la', list)).toBe(true)
  })

  it('non sono prefissi di testo: "git statusx" e "lsof" non passano, ne altri sottocomandi', () => {
    expect(isAllowlisted('git statusx', list)).toBe(false)
    expect(isAllowlisted('lsof', list)).toBe(false)
    expect(isAllowlisted('git push', list)).toBe(false)
    expect(isAllowlisted('npm run build', list)).toBe(false)
  })

  it('un comando permesso concatenato a un altro NON passa', () => {
    for (const c of ['git status; rm x', 'git status && rm x', 'ls | sh', 'ls > f', 'npm test $(x)', 'ls\nrm x']) {
      expect(isAllowlisted(c, list), c).toBe(false)
    }
  })

  it('una voce con metacaratteri non combacia mai e la lista vuota non permette nulla', () => {
    expect(isAllowlisted('ls', ['ls; rm x'])).toBe(false)
    expect(isAllowlisted('ls', [])).toBe(false)
  })
})

describe('readAllowlist', () => {
  it('legge un array di stringhe; rotto o assente = vuoto', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'fa-allow-'))
    try {
      const f = path.join(d, 'a.json')
      writeFileSync(f, JSON.stringify(['git status', 5, null, 'ls']))
      expect(readAllowlist(f)).toEqual(['git status', 'ls'])
      writeFileSync(f, '{not json')
      expect(readAllowlist(f)).toEqual([])
      expect(readAllowlist(path.join(d, 'missing.json'))).toEqual([])
      writeFileSync(f, '{"a":1}')
      expect(readAllowlist(f)).toEqual([])
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
