import { z } from 'zod'

const sel = z.string().min(1) // CSS selector

/**
 * Per-provider DOM description. Lives in config/selectors/<provider>.json and is reloaded without rebuilding.
 * Values come from `npm run inspect <provider>`; never invented.
 */
export const SelectorsSchema = z.object({
  provider: z.string().min(1),
  version: z.number().int().positive(),
  /** Opens a fresh chat. */
  url: z.string().min(1),
  /** Hosts the provider view may navigate to (provider + its login hosts). Everything else is blocked. */
  allowedHosts: z.array(z.string().min(1)).min(1),
  input: sel,
  inputKind: z.enum(['textarea', 'contenteditable']).default('textarea'),
  sendButton: sel,
  /** Matches the send button while it is disabled (empty input) when the site marks that with a class, not the disabled attribute. */
  sendDisabled: sel.optional(),
  /** Present only while the model is generating. May be the same element as sendButton (icon swap): then match the icon, e.g. with :has(). */
  stopButton: sel.optional(),
  /** The model's reasoning text, shown outside the answer (DeepSeek, Qwen thinking). While it grows the model is working, even when no stop button is recognised: it counts as a sign of life for the timeouts. */
  thinking: sel.optional(),
  /** Matches EVERY assistant message container; the last one (beyond the pre-send count) is the current reply. */
  assistantMessage: sel,
  /** Wrapper of a rendered code block (language banner + <pre>). Its banner text and buttons never reach the reply. */
  codeBlock: sel.optional(),
  /** Inside codeBlock: the element whose text is the language label (used when the <pre> has no <code class=language-x>). */
  codeLang: sel.optional(),
  /** Inside a <pre>: one element per code line, for editors (Monaco) whose <pre> text mixes line numbers and banner. Non-breaking spaces become spaces. */
  codeLines: sel.optional(),
  /**
   * How to give the provider images, the way a user does: click `open` (e.g. the "+" button) if the upload entry is in a menu, then click `choose`
   * (the "upload" entry), which opens the file dialog; the app answers that dialog with the files. `ready` matches ONE element per finished upload
   * (the thumbnail): send waits for them. Without `attach` the provider cannot receive images.
   */
  attach: z.object({ open: sel.optional(), choose: sel, ready: sel.optional() }).optional(),
  /** Visible while the page is still booting (splash screen / skeleton): the input can exist long before the page works, so a new chat waits until it is gone. */
  loading: sel.optional(),
  /**
   * A control the site makes you click to carry on, e.g. Qwen's A/B test "I prefer this response" (two answers side by side, the composer hidden until you pick one).
   * While one is on screen the reply is not finished; the first ENABLED match is clicked (it stays disabled until the answers are complete), both while waiting and before a send.
   */
  dismiss: sel.optional(),
  newChatButton: sel.optional(),
  /** Present only when logged out. */
  loginIndicator: sel.optional(),
  /** `label`: inside an option, the element holding just the model name (options may also hold a description and buttons). */
  model: z.object({ trigger: sel, option: sel, current: sel.optional(), label: sel.optional() }).optional(),
  /** Toast / banner regions. Error patterns are tested ONLY on their text, never on model output. */
  errorRegions: sel.optional(),
  /** Case-insensitive regex sources tested on errorRegions text. */
  errors: z
    .partialRecord(z.enum(['rate_limit', 'login_required', 'captcha', 'network']), z.array(z.string()))
    .default({}),
  settle: z
    .object({ idleMs: z.number().int().positive(), maxWaitMs: z.number().int().positive() })
    .default({ idleMs: 1500, maxWaitMs: 300_000 })
})
export type SelectorsConfig = z.infer<typeof SelectorsSchema>
