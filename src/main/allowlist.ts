import { readFileSync } from 'node:fs'

/**
 * Splits `cmd` into words ONLY if it is a single simple command. Anything that can chain, redirect, substitute, expand
 * or escape (; & | < > ( ) ` $ \ { } * ? ~ ! #, newlines, `$`/backtick/backslash even inside double quotes) returns null.
 */
export function simpleTokens(cmd: string): string[] | null {
  if (/[\n\r\0]/.test(cmd)) return null
  const tokens: string[] = []
  let cur = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else if (quote === '"' && /[$`\\]/.test(ch)) return null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inWord = true
    } else if (/\s/.test(ch)) {
      if (inWord) tokens.push(cur)
      cur = ''
      inWord = false
    } else if (/[;&|<>()`$\\{}*?~!#]/.test(ch)) return null
    else {
      cur += ch
      inWord = true
    }
  }
  if (quote) return null
  if (inWord) tokens.push(cur)
  return tokens.length ? tokens : null
}

/**
 * An entry is a command PREFIX, word by word: "git status" allows `git status` and `git status -s`, not `git push`.
 * Extra arguments are the user's call (so "git diff" also allows `git diff --output=file`): keep entries narrow.
 */
export function isAllowlisted(cmd: string, allowlist: string[]): boolean {
  const words = simpleTokens(cmd)
  if (!words) return false
  return allowlist.some((entry) => {
    const prefix = simpleTokens(entry)
    return !!prefix && prefix.length <= words.length && prefix.every((w, i) => w === words[i])
  })
}

/** The user's file: a JSON array of strings. Missing or broken means empty (everything asks). */
export function readAllowlist(file: string): string[] {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
