import type { RiskLevel } from '@contracts/agent'
import type { PermissionMode } from '@contracts/permissions'

export type Verdict = { verdict: 'allow' } | { verdict: 'ask' } | { verdict: 'deny'; reason: string }

/**
 * The whole permission matrix in one place.
 * - Anything outside the workspace always asks, in every mode.
 * - bash asks unless the user's allowlist covers it or the mode is full; read-only mode refuses it.
 * - Writes: read-only refuses, ask asks, auto and full let them through inside the workspace.
 */
export function decide(mode: PermissionMode, risk: RiskLevel, outside: boolean, allowlisted: boolean): Verdict {
  if (risk === 'exec') {
    if (mode === 'readonly') return { verdict: 'deny', reason: 'read-only mode: commands are not allowed' }
    return { verdict: mode === 'full' || allowlisted ? 'allow' : 'ask' }
  }
  if (risk === 'write' && mode === 'readonly') return { verdict: 'deny', reason: 'read-only mode: changes are not allowed' }
  if (outside) return { verdict: 'ask' }
  if (risk === 'write' && mode === 'ask') return { verdict: 'ask' }
  return { verdict: 'allow' }
}
