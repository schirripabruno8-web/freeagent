/**
 * readonly: no writes, no bash. ask: every write/bash asks. auto: writes inside the workspace go through, bash still asks.
 * full: writes AND bash go through; anything outside the workspace still asks.
 */
export type PermissionMode = 'readonly' | 'ask' | 'auto' | 'full'

export type ApprovalKind = 'write' | 'outside' | 'bash' | 'mcp'

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  tool: string
  /** One line, e.g. "edit src/a.ts" or "bash: npm test". */
  summary: string
  /** Unified diff for write/edit, the command for bash. May be empty. */
  detail: string
  /** True when at least one path is outside the workspace. */
  outside: boolean
  /** Which agent is asking (absent = the main agent). */
  agent?: string
}

export interface CheckpointInfo {
  id: string
  ts: number
  tool: string
  files: string[]
}

/** Path rules for one workspace. Windows: no ADS, no device names, no \\?\ prefixes, no trailing dots/spaces, symlinks/junctions resolved. */
export interface Sandbox {
  classify(p: string): { ok: true; abs: string; inside: boolean } | { ok: false; reason: string }
  /** Absolute (real) path for p. Throws on forbidden forms, and when outside the workspace unless allowOutside. */
  resolve(p: string, allowOutside: boolean): string
}
