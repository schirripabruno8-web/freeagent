import type { AgentEvent, AgentReport, AuthDecision, Authorizer, ToolCall, ToolContext, ToolDef } from '@contracts/agent'
import type { Sandbox } from '@contracts/permissions'
import { ProviderError, type ProviderAdapter } from '@contracts/provider'
import { buildBootstrap, finishTool, formatBounce, invalidBounce, nativeBounce, reminderText, type McpBrief } from './bootstrap'
import { parseReply } from './parser'

export interface AgentOptions {
  adapter: ProviderAdapter
  /** `finish` is added automatically. */
  tools: ToolDef[]
  task: string
  cwd: string
  authorize: Authorizer
  /** Path rules. Without one, every file tool fails: there is no insecure default. */
  sandbox?: Sandbox
  /** Snapshots files before a change; returns the checkpoint id. */
  checkpoint?: (tool: string, files: string[]) => Promise<string>
  emit: (e: AgentEvent) => void
  signal?: AbortSignal
  maxSteps?: number
  maxCallsPerTurn?: number
  maxResultChars?: number
  /** Skills this agent may load with the `load_skill` tool (names and descriptions are listed in its first message). */
  skills?: { name: string; description: string }[]
  /** MCP servers this agent may use, listed in its first message (the tools themselves come with `tools`). */
  mcp?: McpBrief[]
  /** Always-on rules (ponytail) put in the first message, after the protocol. */
  prelude?: string
  /** Set for a sub-agent: "<name>: <description>". Added to its first message. */
  role?: string
  /** Image files (absolute paths) sent with the FIRST message only; a rollover into a new chat does not repeat them. */
  images?: string[]
  /** Model id to pick on the page after the new chat ("default" or unset = leave the page as it is). */
  model?: string
  /** When one chat has carried this many characters, the agent summarises and continues in a new chat (default 120000). */
  maxChatChars?: number
  /** Carry on in the chat the page is showing (no new chat, no model change): the task is a follow-up from the user. */
  resume?: boolean
  /** Wait before resending after an interrupted answer, times the attempt number (default 5000; tests use 0). */
  retryDelayMs?: number
  /** Inject a hidden reminder every N steps. */
  remindEvery?: number
  /** Consecutive replies without a usable command tolerated before giving up / accepting the text. */
  maxBounces?: number
}

interface Result {
  id: string
  tool: string
  ok: boolean
  output: string
}

export function compactResult(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  return `${text.slice(0, head)}\n[... ${text.length - max} chars omitted ...]\n${text.slice(text.length - (max - head))}`
}

// Tool output is data from the outside world: it must not be able to close its own wrapper.
const wrap = (r: Result): string =>
  `[tool_result id=${r.id} tool=${r.tool} ok=${r.ok}]\n${r.output.replaceAll('[/tool_result', '[ /tool_result')}\n[/tool_result]`

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const MAX_RETRIES = 2

const SUMMARY_REQUEST =
  '[summary] This chat is getting long and will be replaced by a new one. Reply with plain text, no command block: a summary of the task so far (the goal, what is done with file paths and commands run, what is left, and any names, values or decisions you will need). Under 400 words.'

export async function runAgent(o: AgentOptions): Promise<AgentReport> {
  const maxSteps = o.maxSteps ?? 30
  const maxCalls = o.maxCallsPerTurn ?? 3
  const maxChars = o.maxResultChars ?? 6000
  const remindEvery = o.remindEvery ?? 8
  const maxBounces = o.maxBounces ?? 2
  const tools = [...o.tools, finishTool]
  const byName = new Map(tools.map((t) => [t.name, t]))
  const report = (reason: AgentReport['reason'], summary: string, steps: number, errorKind?: string): AgentReport => {
    const r: AgentReport = { reason, summary, steps, ...(errorKind ? { errorKind } : {}) }
    o.emit({ type: 'finished', report: r })
    return r
  }

  // A sub-agent's finish summary becomes its report to the agent that delegated: it must stand on its own.
  const rolePrefix = o.role
    ? `ROLE: ${o.role}\nYou are a sub-agent. Your finish summary goes back to the main agent as your report: make it short, concrete and self-contained (what you found or changed, with file paths).\n`
    : ''
  let step = 0
  let bounces = 0
  let chatChars = 0 // what this chat has carried so far, in both directions
  let rollovers = 0
  const maxChat = o.maxChatChars ?? 120_000
  const prelude = o.prelude ? `${o.prelude}\n\n` : ''
  const firstMessage = (): string => `${buildBootstrap(tools, maxCalls, o.skills, o.mcp)}\n\n${prelude}${rolePrefix}WORKSPACE: ${o.cwd}\n${o.resume ? 'FOLLOW-UP from the user (same work as before: use the earlier conversation above and the files it produced; do not start over):' : 'TASK:'}\n${o.task}`

  /** A new chat on the same site, with the chosen model (a new chat resets it). */
  async function freshChat(): Promise<void> {
    o.emit({ type: 'status', text: 'new chat' })
    await o.adapter.newChat()
    if (o.model && o.model !== 'default') {
      try {
        await o.adapter.selectModel(o.model)
        o.emit({ type: 'status', text: `model: ${o.model}` })
      } catch (e) {
        // The task can still run on the page's current model: say so instead of failing it.
        o.emit({ type: 'status', text: `could not select model "${o.model}" (${errMsg(e)}): using the page's current one` })
      }
    }
    chatChars = 0
  }

  async function readReply(): Promise<string> {
    let reply = ''
    for await (const s of o.adapter.stream(o.signal)) {
      reply = s.text
      o.emit({ type: 'assistant', text: s.text, done: s.done })
    }
    chatChars += reply.length
    return reply
  }

  /** The chat got long: ask for a summary, open a new chat and carry on there. `pending` (what was about to be sent) is not lost. */
  async function rollover(pending: string): Promise<string> {
    o.emit({ type: 'status', text: 'long chat: asking for a summary, then continuing in a new chat' })
    await o.adapter.send(SUMMARY_REQUEST)
    const summary = parseReply(await readReply(), { final: true }).text || '(the model gave no summary)'
    await freshChat()
    return `${firstMessage()}\n\nPROGRESS SO FAR (written by you in the previous chat, which is gone):\n${summary}\n\nContinue from here. This is what was about to be sent to you:\n${pending}`
  }

  try {
    if (o.resume) {
      o.emit({ type: 'status', text: 'follow-up in the current chat' })
      chatChars = 0
    } else await freshChat()
    let outgoing = firstMessage()

    while (step < maxSteps) {
      if (o.signal?.aborted) return report('aborted', 'Stopped by the user.', step)
      step++
      if (step > 1 && rollovers < 5 && chatChars + outgoing.length > maxChat) {
        outgoing = await rollover(outgoing)
        rollovers++
      }
      let reply = ''
      for (let attempt = 0; ; attempt++) {
        try {
          // images only with the very first message (a retry's chat already has them)
          await o.adapter.send(outgoing, step === 1 && attempt === 0 ? o.images : undefined)
          chatChars += outgoing.length
          reply = await readReply()
          break
        } catch (e) {
          // The site dropped the message or gave up mid-answer (server busy): sending it again usually works.
          if (!(e instanceof ProviderError) || e.kind !== 'interrupted' || attempt >= MAX_RETRIES || o.signal?.aborted) throw e
          o.emit({ type: 'status', text: `the provider interrupted the answer (${e.message}); sending again (${attempt + 1}/${MAX_RETRIES})` })
          await new Promise((r) => setTimeout(r, (o.retryDelayMs ?? 5000) * (attempt + 1)))
        }
      }
      const parsed = parseReply(reply, { final: true })

      if (parsed.kind === 'text') {
        if (++bounces > maxBounces) return report('finish', parsed.text || reply, step) // model just answers in prose
        o.emit({ type: 'reminder', kind: 'format' })
        outgoing = formatBounce(tools)
        continue
      }
      if (parsed.kind !== 'calls') {
        // invalid, native tool failure, or (cannot happen with final:true) incomplete
        if (++bounces > maxBounces + 1) return report('error', 'The model keeps replying without a usable command.', step)
        const native = parsed.kind === 'native_tool_failure'
        o.emit({ type: 'reminder', kind: native ? 'native' : 'format' })
        outgoing = native ? nativeBounce() : invalidBounce(parsed.kind === 'invalid' ? parsed.errors : ['reply cut off'])
        continue
      }

      bounces = 0
      const results: Result[] = []
      let failed = false
      const calls: ToolCall[] = parsed.calls.map((c, i) => ({ ...c, id: `${step}.${i + 1}` }))
      for (let i = 0; i < calls.length; ) {
        const call = calls[i]!
        if (failed || i >= maxCalls) {
          results.push({ id: call.id, tool: call.tool, ok: false, output: failed ? 'not run: a previous command in this batch failed' : `not run: max ${maxCalls} commands per reply` })
          i++
          continue
        }
        if (byName.get(call.tool)?.parallel) {
          // Consecutive delegations run side by side; a failure in one does not cancel the others, but stops what comes after.
          let j = i
          while (j < calls.length && j < maxCalls && byName.get(calls[j]!.tool)?.parallel) j++
          const batch = calls.slice(i, j)
          for (const c of batch) o.emit({ type: 'tool_call', call: c })
          const done = await Promise.all(batch.map(execute))
          for (const r of done) {
            o.emit({ type: 'tool_result', id: r.id, ok: r.ok, output: r.output })
            results.push(r)
          }
          failed = done.some((r) => !r.ok)
          i = j
          continue
        }
        o.emit({ type: 'tool_call', call })
        const r = await execute(call)
        o.emit({ type: 'tool_result', id: r.id, ok: r.ok, output: r.output })
        if (r.ok && call.tool === 'finish') return report('finish', r.output, step)
        results.push(r)
        failed = !r.ok
        i++
      }
      outgoing = results.map(wrap).join('\n')
      if (step % remindEvery === 0) {
        o.emit({ type: 'reminder', kind: 'periodic' })
        outgoing += `\n${reminderText(tools)}`
      }
    }
    return report('max_steps', `Reached the step limit (${maxSteps}).`, step)
  } catch (e) {
    if (e instanceof ProviderError) {
      if (e.kind === 'aborted') return report('aborted', 'Stopped by the user.', step)
      o.emit({ type: 'error', kind: e.kind, message: e.message })
      return report('error', `${e.kind}: ${e.message}`, step, e.kind)
    }
    o.emit({ type: 'error', kind: 'internal', message: errMsg(e) })
    return report('error', errMsg(e), step)
  }

  function contextFor(call: ToolCall, decision: Extract<AuthDecision, { allow: true }>): ToolContext {
    return {
      cwd: o.cwd,
      signal: o.signal,
      resolve: (p) => {
        if (!o.sandbox) throw new Error('no sandbox configured')
        return o.sandbox.resolve(p, decision.outside === true)
      },
      checkpoint: async (files) => {
        if (!o.checkpoint) throw new Error('no checkpoint store configured')
        await o.checkpoint(call.tool, files)
      }
    }
  }

  async function execute(call: ToolCall): Promise<Result> {
    const fail = (output: string): Result => ({ id: call.id, tool: call.tool, ok: false, output })
    const def = byName.get(call.tool)
    if (!def) return fail(`unknown tool "${call.tool}". Available: ${tools.map((t) => t.name).join(', ')}`)
    const args = def.schema.safeParse(call.args)
    if (!args.success) {
      return fail(`invalid args for ${call.tool}: ${args.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}. Expected ${def.argsHint}`)
    }
    const decision = await o.authorize(call, def)
    if (!decision.allow) return fail(`denied: ${decision.reason}`)
    const ctx = contextFor(call, decision)
    try {
      const out = await def.run(args.data, ctx)
      return { id: call.id, tool: call.tool, ok: true, output: compactResult(out, maxChars) }
    } catch (e) {
      return fail(errMsg(e))
    }
  }
}
