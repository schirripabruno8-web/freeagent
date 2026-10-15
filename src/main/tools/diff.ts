import path from 'node:path'
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff'

const MAX_CHARS = 20000

/** Diff label: the path relative to the workspace, always with '/'. */
export const relLabel = (cwd: string, abs: string): string => path.relative(cwd, abs).split(path.sep).join('/')

/** Unified diff old -> new, '' when nothing changed. Cut so one big edit cannot flood the model's context. */
export function makeDiff(label: string, oldText: string, newText: string): string {
  if (oldText === newText) return ''
  const patch = createTwoFilesPatch(`a/${label}`, `b/${label}`, oldText, newText, undefined, undefined, {
    context: 3,
    headerOptions: FILE_HEADERS_ONLY
  })
  return patch.length > MAX_CHARS ? `${patch.slice(0, MAX_CHARS)}\n[diff truncated]` : patch
}
