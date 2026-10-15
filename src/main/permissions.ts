import type { AuthDecision, Authorizer, ToolContext } from '@contracts/agent'
import type { ApprovalRequest, PermissionMode, Sandbox } from '@contracts/permissions'
import { isAllowlisted } from './allowlist'
import { decide } from './policy'

export interface PermissionDeps {
  cwd: string
  sandbox: Sandbox
  getMode(): PermissionMode
  /** Re-read on every call: the user edits the file while the app runs. */
  allowlist(): string[]
  /** Resolves true only if the user clicked Allow. Must resolve false when the task is stopped. */
  requestApproval(req: Omit<ApprovalRequest, 'id'>): Promise<boolean>
  /** True right after an outside result that read like orders: even in auto/full the next change or command asks. */
  forceAsk?(): boolean
  /** Called after the user answered a question: the suspicion has been dealt with. */
  onAsked?(): void
}

const DETAIL_CAP = 50_000
const firstLine = (s: string): string => (s.split('\n')[0] ?? '').slice(0, 200)

/**
 * The gate every tool call passes. Order matters: refuse forbidden paths first (never asks), then the mode matrix,
 * then validate by previewing (a broken edit is the model's mistake, not a question for the user), then ask.
 */
export function makeAuthorizer(d: PermissionDeps): Authorizer {
  // previews may read anywhere (the user decides), never write
  const previewCtx: ToolContext = {
    cwd: d.cwd,
    resolve: (p) => d.sandbox.resolve(p, true),
    checkpoint: async () => {
      throw new Error('a preview must not modify anything')
    }
  }
  return async (call, def): Promise<AuthDecision> => {
    const parsed = def.schema.safeParse(call.args)
    if (!parsed.success) return { allow: false, reason: 'invalid arguments' }
    const args = parsed.data as Record<string, unknown>

    let outside = false
    const paths = def.paths?.(args) ?? []
    for (const p of paths) {
      const c = d.sandbox.classify(p)
      if (!c.ok) return { allow: false, reason: `path refused: ${c.reason}` }
      if (!c.inside) outside = true
    }

    // Some tools (an MCP call) only sometimes change things: the call decides its own risk.
    const risk = def.riskFor?.(args) ?? def.risk
    const command = risk === 'exec' ? String(args['command'] ?? '') : ''
    let v = decide(d.getMode(), risk, outside, risk === 'exec' && isAllowlisted(command, d.allowlist()))
    if (v.verdict === 'deny') return { allow: false, reason: v.reason }
    let tainted = false
    if (v.verdict === 'allow' && risk !== 'read' && d.forceAsk?.()) {
      v = { verdict: 'ask' } // an outside result just told the model what to do: do not let that go through unseen
      tainted = true
    }
    if (v.verdict === 'allow') return { allow: true }

    let detail = ''
    try {
      detail = (await def.preview?.(args, previewCtx)) ?? ''
      if (tainted) detail = `WARNING: a tool result a moment ago read like instructions. Check that this is what you wanted.

${detail}`
    } catch (e) {
      return { allow: false, reason: e instanceof Error ? e.message : String(e) }
    }
    const ok = await d.requestApproval({
      kind: def.name === 'mcp_call' ? 'mcp' : risk === 'exec' ? 'bash' : outside ? 'outside' : 'write',
      tool: def.name,
      summary: risk === 'exec' ? `bash: ${firstLine(command)}` : (def.summary?.(args) ?? `${def.name} ${paths.join(', ')}`.trim()),
      detail: detail.length > DETAIL_CAP ? `${detail.slice(0, DETAIL_CAP)}\n[... cut]` : detail,
      outside
    })
    d.onAsked?.()
    return ok ? { allow: true, outside } : { allow: false, reason: 'the user declined' }
  }
}
