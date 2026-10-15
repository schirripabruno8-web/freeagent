import type { z } from 'zod'

export interface ToolCall {
  id: string
  tool: string
  args: unknown
}

export type RiskLevel = 'read' | 'write' | 'exec'

export interface ToolContext {
  /** The workspace root. */
  cwd: string
  signal?: AbortSignal
  /** The ONLY way file tools turn a model-supplied path into an absolute one (sandbox-checked; see contracts/permissions.ts). */
  resolve(p: string): string
  /** Snapshots the files as they are now, so the change can be undone. Call before modifying anything. */
  checkpoint(files: string[]): Promise<void>
}

export interface ToolDef<A = any> {
  name: string
  /** One line shown to the model in the bootstrap. */
  description: string
  /** Compact argument signature shown to the model, e.g. {"path": string}. */
  argsHint: string
  schema: z.ZodType<A>
  risk: RiskLevel
  /** When the risk depends on the arguments (an MCP call may only read). Overrides `risk`. */
  riskFor?(args: A): RiskLevel
  /** Consecutive calls to parallel tools in one reply run at the same time (delegation), not one after the other. */
  parallel?: boolean
  /** One line for the approval dialog, when `name + paths` says too little. */
  summary?(args: A): string
  /** Paths (as the model wrote them) this call touches. File tools MUST declare them: the permission layer sandbox-checks and asks about each. */
  paths?(args: A): string[]
  /** Text for the approval dialog (unified diff for write/edit, the command for bash). Must not change anything. */
  preview?(args: A, ctx: ToolContext): Promise<string>
  run(args: A, ctx: ToolContext): Promise<string>
}

/** `outside: true` = the user approved touching paths outside the workspace for this call. */
export type AuthDecision = { allow: true; outside?: boolean } | { allow: false; reason: string }
/** Permission gate. Phase 1 plugs the real policy (mode, sandbox, approval UI) in here. */
export type Authorizer = (call: ToolCall, def: ToolDef) => Promise<AuthDecision>

export type ParseOutcome =
  /** One or more well-formed tool blocks. `text` is the prose around them. */
  | { kind: 'calls'; calls: ToolCall[]; text: string }
  /** No tool block at all: plain prose. */
  | { kind: 'text'; text: string }
  /** A tool block is still open and the stream is not final. */
  | { kind: 'incomplete'; text: string }
  /** Tool block(s) present but unusable (bad JSON, missing "tool", truncated at final). */
  | { kind: 'invalid'; text: string; errors: string[] }
  /** The site's own tool runtime answered instead of us ("Tool x does not exist"). */
  | { kind: 'native_tool_failure'; text: string }

export interface AgentReport {
  summary: string
  steps: number
  reason: 'finish' | 'max_steps' | 'aborted' | 'error'
  /** Set when reason is 'error' because the chat site failed (ProviderErrorKind), e.g. 'rate_limit'. */
  errorKind?: string
}

export type AgentEventBody =
  /** What the user asked (the start of a run); `resume` = a follow-up in the same chat. */
  | { type: 'user'; text: string; resume?: boolean; images?: number }
  | { type: 'status'; text: string }
  | { type: 'assistant'; text: string; done: boolean }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; id: string; ok: boolean; output: string }
  /** A format reminder was injected; the UI hides the text. */
  | { type: 'reminder'; kind: 'periodic' | 'format' | 'native' }
  | { type: 'finished'; report: AgentReport }
  | { type: 'error'; kind: string; message: string }
  /** An agent (main or sub) changed state. Shown in the agents panel. */
  | { type: 'agent'; id: string; name: string; provider: string; status: 'queued' | 'running' | 'done' | 'error' | 'stopped'; note?: string }

/** Every event may carry the id of the agent it belongs to (absent = the main agent). */
export type AgentEvent = AgentEventBody & { agent?: string }
