import {
  ProviderError,
  type AdapterStatus,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderErrorKind,
  type SelfTestReport,
  type StreamSnapshot
} from '../../../contracts/provider'
import type { Page } from '../../../contracts/page'
import type { SelectorsConfig } from '../../../contracts/selectors'

const FENCE = '```'
const BT = '`'
const HARD_CAP_FACTOR = 6

// Page-side helpers. `a` (args) is defined by script(); values only enter through JSON.stringify.
// Rebuilds a message as markdown: <pre> -> fenced block, <code> -> backticks, <br> -> newline.
const HELPERS = String.raw`
const $$ = (s) => {
  if (!s) return [];
  try { return [...document.querySelectorAll(s)]; } catch (e) { return []; }
};
const $ = (s) => $$(s)[0] || null;
const attr = (e, n) => (e && e.getAttribute(n)) || '';
const hidden = (e) => {
  const cs = getComputedStyle(e);
  return e.hasAttribute('hidden') || cs.display === 'none' || cs.visibility === 'hidden';
};
const is = (e, s) => { try { return !!s && e.matches(s); } catch (x) { return false; } };
const one = (root, s) => { try { return s ? root.querySelector(s) : null; } catch (x) { return null; } };
const live = (e) => !hidden(e) && !e.disabled && attr(e, 'aria-disabled') !== 'true' && !e.classList.contains('disabled');
const BLOCK = /^(P|DIV|UL|OL|LI|H[1-6]|BLOCKQUOTE|PRE)$/;
function kids(el, raw) {
  let out = '';
  for (const c of el.childNodes) {
    const t = node(c, raw);
    if (!t) continue;
    if (c.nodeType === 1 && BLOCK.test(c.tagName)) {
      out = out.replace(/ +$/, '');
      if (out && !out.endsWith('\n')) out += '\n';
    }
    out += t;
  }
  return out;
}
function node(n, raw) {
  if (n.nodeType === 3) return raw ? n.nodeValue : n.nodeValue.replace(/\s+/g, ' ');
  if (n.nodeType !== 1 || /^(BUTTON|SCRIPT|STYLE)$/.test(n.tagName) || n.getAttribute('role') === 'button' || hidden(n)) return '';
  const t = n.tagName;
  if (is(n, a.codeBlock)) { const p = n.querySelector('pre'); return p ? pre(p, n) : ''; }
  if (t === 'PRE') return pre(n, n);
  if (t === 'CODE') return a.bt + n.textContent + a.bt;
  if (t === 'BR') return '\n';
  const s = kids(n, raw);
  if (t === 'LI') return s.trim() ? '- ' + s.trim() + '\n' : '';
  if (BLOCK.test(t)) return s.trim() ? s.trim() + '\n' : '';
  return s;
}
function pre(p, w) {
  const code = p.querySelector('code');
  const m = /(?:^|\s)language-(\S+)/.exec(attr(code, 'class'));
  let lang = (m && m[1]) || attr(code, 'data-language') || attr(p, 'data-language');
  if (!lang && w) {
    const l = one(w, a.codeLang);
    const t = l ? l.textContent.trim().toLowerCase() : '';
    if (/^[\w+.-]{1,20}$/.test(t)) lang = t;
  }
  // Editors draw one element per line (Monaco: absolutely positioned, with non-breaking spaces); the <pre> text would carry line numbers and the banner.
  let rows = [];
  try { rows = a.codeLines ? [...p.querySelectorAll(a.codeLines)] : []; } catch (x) {}
  rows.sort((x, y) => (parseFloat(x.style.top) || 0) - (parseFloat(y.style.top) || 0));
  const body = rows.length ? rows.map((r) => r.textContent.replace(/ /g, ' ')).join('\n') : code ? code.textContent : kids(p, true);
  return a.fence + lang + '\n' + body.replace(/\n$/, '') + '\n' + a.fence + '\n';
}
`

const READ = String.raw`
const msgs = $$(a.assistant);
const input = $(a.input);
const send = $(a.send);
const stop = $(a.stop);
const val = input ? (input.value !== undefined ? input.value : input.textContent) : '';
return {
  count: msgs.length,
  text: msgs.length ? kids(msgs[msgs.length - 1], false).trim() : '',
  generating: !!stop && !hidden(stop),
  think: $$(a.think).reduce((n, e) => n + e.textContent.length, 0),
  blocked: $$(a.dismiss).filter((e) => !hidden(e)).length,
  canDismiss: $$(a.dismiss).some(live),
  sendReady: !!send && !send.disabled && attr(send, 'aria-disabled') !== 'true' && !is(send, a.sendOff),
  inputEmpty: !!input && val.trim() === '',
  hasInput: !!input,
  loggedOut: !!$(a.login),
  // Error regions inside a model message are ignored: patterns must never match model output.
  errors: $$(a.errors).filter((e) => !msgs.some((m) => m.contains(e))).map((e) => e.textContent)
};
`

const CLICK = 'const el = $(a.sel); if (!el) return false; el.click(); return true;'
const DISMISS = 'const el = $$(a.sel).find(live); if (!el) return false; el.click(); return true;'
const FOCUS = 'const el = $(a.sel); if (!el) return false; el.focus(); return true;'
const ESCAPE =
  "document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;"
const NAME = "const name = (o) => (one(o, a.label) || o).textContent.trim();"
const OPTIONS =
  NAME + " return $$(a.option).map((o) => ({ id: attr(o, 'data-value') || name(o), label: name(o) }));"
const PICK =
  NAME + " const hit = $$(a.option).find((o) => attr(o, 'data-value') === a.pick || name(o) === a.pick);" +
  ' if (!hit) return false; hit.click(); return true;'
// Resolves once the page has not changed for `quiet` ms (or after `max`): an SPA shows its input long before its menus and buttons are alive.
const QUIET =
  'return new Promise((resolve) => { let t; const done = () => { obs.disconnect(); resolve(true); };' +
  ' const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, a.quiet); });' +
  ' obs.observe(document.body, { subtree: true, childList: true, attributes: true });' +
  ' t = setTimeout(done, a.quiet); setTimeout(done, a.max); });'
const BUSY = 'return $$(a.sel).some((e) => !hidden(e));'
const COUNT = 'return Object.fromEntries(Object.entries(a.sels).map(([k, s]) => [k, $$(s).length]));'

const script = (body: string, args: Record<string, unknown>) =>
  `(() => {\nconst a = ${JSON.stringify({ fence: FENCE, bt: BT, ...args })};\n${HELPERS}\n${body}\n})()`

interface PageState {
  count: number
  text: string
  generating: boolean
  /** Total length of the reasoning text on the page (0 when `thinking` is not configured). */
  think: number
  /** Visible `dismiss` controls (enabled or not), and whether one can be clicked now. */
  blocked: number
  canDismiss: boolean
  sendReady: boolean
  inputEmpty: boolean
  hasInput: boolean
  loggedOut: boolean
  errors: string[]
}

const readArgs = (c: SelectorsConfig) => ({
  assistant: c.assistantMessage,
  input: c.input,
  send: c.sendButton,
  sendOff: c.sendDisabled,
  codeBlock: c.codeBlock,
  codeLang: c.codeLang,
  codeLines: c.codeLines,
  stop: c.stopButton,
  think: c.thinking,
  dismiss: c.dismiss,
  login: c.loginIndicator,
  errors: c.errorRegions
})

const errorKind = (c: SelectorsConfig, texts: string[]): ProviderErrorKind | undefined => {
  for (const [kind, patterns] of Object.entries(c.errors)) {
    if (patterns?.some((p) => texts.some((t) => new RegExp(p, 'i').test(t)))) return kind as ProviderErrorKind
  }
}

/** One engine for every provider: all behaviour comes from the SelectorsConfig returned by getConfig(). */
export function createSelectorAdapter(
  page: Page,
  getConfig: () => SelectorsConfig,
  opts: { pollMs?: number; menuSettleMs?: number; domQuietMs?: number; startGraceMs?: number; stallMs?: number } = {}
): ProviderAdapter {
  const pollMs = opts.pollMs ?? 250
  // A menu is drawn in pieces (Qwen: 2 of 13 entries right after the click) and its entries answer clicks only once drawn: wait before clicking one.
  const menuSettleMs = opts.menuSettleMs ?? 800
  const domQuietMs = opts.domQuietMs ?? 1000
  // After a send the model must show a sign of life (stop button or first text) within this time; a site that silently dropped the message otherwise leaves us waiting for maxWaitMs.
  const startGraceMs = opts.startGraceMs ?? 90_000
  // Reasoning that stops growing, with no answer and no stop button, means the site gave up (DeepSeek: "server temporarily unavailable" + "Continue"); the wording is localised, so it is detected by behaviour.
  const stallMs = opts.stallMs ?? 30_000
  // Last assistant state when send() started. Count alone fails on virtualised lists (old items unmount), so the last text counts too.
  let baseline = 0
  let baselineText = ''

  const run = <T>(body: string, args: Record<string, unknown> = {}) => page.evaluate<T>(script(body, args))
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const poll = async <T>(ms: number, probe: () => Promise<T | false>): Promise<T | false> => {
    const end = Date.now() + ms
    for (;;) {
      const v = await probe()
      if (v) return v
      if (Date.now() >= end) return false
      await sleep(pollMs)
    }
  }
  const read = () => run<PageState>(READ, readArgs(getConfig()))
  const broken = (why: string) => new ProviderError('selector_broken', why)

  return {
    get id() {
      return getConfig().provider
    },

    async status() {
      const s = await read()
      const loggedIn = s.loggedOut ? false : s.hasInput ? true : 'unknown'
      const st: AdapterStatus = { loggedIn, url: page.url() }
      if (loggedIn === false) st.error = 'login_required'
      return st
    },

    async listModels() {
      const m = getConfig().model
      if (!m || !(await run<boolean>(CLICK, { sel: m.trigger }))) return []
      // shortcut: options are read right after the click (sync render), a site that renders them later needs a poll here, when a real provider does that
      const models = await run<ModelInfo[]>(OPTIONS, { option: m.option, label: m.label })
      await run(ESCAPE)
      return models
    },

    async selectModel(modelId) {
      const m = getConfig().model
      if (!m) throw broken('model selector not configured')
      if (!(await run<boolean>(CLICK, { sel: m.trigger }))) throw broken('model trigger not found')
      if (!(await run<boolean>(PICK, { option: m.option, label: m.label, pick: modelId }))) {
        await run(ESCAPE)
        throw broken(`model not offered by page: ${modelId}`)
      }
    },

    async newChat() {
      const cfg = getConfig()
      if (cfg.newChatButton) {
        if (!(await run<boolean>(CLICK, { sel: cfg.newChatButton }))) throw broken('new chat button not found')
      } else {
        await page.goto(cfg.url)
      }
      const ready = await poll(10_000, async () => {
        const s = await read()
        return s.hasInput || s.loggedOut ? s : false
      })
      if (ready && ready.loggedOut) throw new ProviderError('login_required', 'not logged in: log in by hand in the provider view')
      if (!ready) throw broken('input not found after newChat')
      if (cfg.loading) await poll(20_000, async () => !(await run<boolean>(BUSY, { sel: cfg.loading })))
      if (domQuietMs > 0) await run(QUIET, { quiet: domQuietMs, max: 8_000 })
    },

    async send(text, images) {
      const cfg = getConfig()
      // a pending choice (Qwen's A/B) hides the composer: make it first
      for (let i = 0; cfg.dismiss && i < 5 && (await read()).canDismiss; i++) {
        await run<boolean>(DISMISS, { sel: cfg.dismiss })
        await poll(5_000, async () => (await read()).hasInput)
      }
      const before = await read()
      baseline = before.count
      baselineText = before.text
      if (images?.length) {
        const at = cfg.attach
        if (!at) throw broken(`${cfg.provider} has no attach selectors: it cannot receive images yet`)
        const count = async (s: string) => (await run<Record<string, number>>(COUNT, { sels: { s } }))['s'] ?? 0
        const click = async (s: string, what: string) => {
          if (!(await run<boolean>(CLICK, { sel: s }))) throw broken(`${what} not found`)
        }
        // The whole opening sequence runs inside attachFiles: the page must have the focus and the file dialog must already be watched when the entry is clicked.
        await page.attachFiles(async () => {
          if (at.open) {
            await click(at.open, 'attach button')
            if (!(await poll(3_000, async () => (await count(at.choose)) > 0))) throw broken('attach menu entry not found')
            await sleep(menuSettleMs)
          }
          await click(at.choose, 'attach menu entry')
        }, images)
        if (at.ready && !(await poll(60_000, async () => (await count(at.ready!)) >= images.length))) {
          throw new ProviderError('timeout', 'image upload did not finish')
        }
      }
      if (!(await run<boolean>(FOCUS, { sel: cfg.input }))) throw broken('input not found')
      await page.insertText(text)
      // typing enables the send button; if it never does, the click is a no-op and the check below fails. Images upload first: give them time.
      await poll(images?.length && !cfg.attach?.ready ? 60_000 : 2_000, async () => (await read()).sendReady)
      if (!(await run<boolean>(CLICK, { sel: cfg.sendButton }))) throw broken('send button not found')
      const sent = await poll(3_000, async () => {
        const s = await read()
        return s.inputEmpty || s.generating ? s : false
      })
      if (!sent) {
        const s = await read()
        throw new ProviderError(errorKind(cfg, s.errors) ?? 'selector_broken', 'message was not sent')
      }
    },

    async *stream(signal?: AbortSignal): AsyncGenerator<StreamSnapshot> {
      let last = ''
      const startedAt = Date.now()
      let changedAt = startedAt // last answer-text change: idle is measured from it
      let aliveAt = startedAt // last sign of life (new answer text OR growing reasoning): the timeouts are measured from it
      let lastThink: number | undefined
      let sawThinking = false
      for (;;) {
        if (signal?.aborted) throw new ProviderError('aborted', 'stream aborted')
        const cfg = getConfig()
        const s = await read()
        if (cfg.dismiss && s.canDismiss) {
          await run<boolean>(DISMISS, { sel: cfg.dismiss })
          aliveAt = Date.now()
          await sleep(pollMs)
          continue
        }
        const kind = errorKind(cfg, s.errors)
        if (kind) throw new ProviderError(kind, `provider reported ${kind}`)
        if (lastThink !== undefined && s.think !== lastThink) {
          aliveAt = Date.now()
          sawThinking = true
        }
        lastThink = s.think
        if ((s.count > baseline || s.text !== baselineText) && s.text && s.text !== last) {
          last = s.text
          changedAt = aliveAt = Date.now()
          yield { text: last, done: false }
        } else if (last && !s.generating && !s.blocked && Date.now() - changedAt >= cfg.settle.idleMs) {
          yield { text: last, done: true }
          return
        } else if (!last && !s.generating && sawThinking && Date.now() - aliveAt > stallMs) {
          throw new ProviderError('interrupted', 'the provider stopped while reasoning, without an answer (server error?)')
        } else if (!last && !s.generating && Date.now() - aliveAt > startGraceMs) {
          throw new ProviderError('interrupted', 'the provider never started answering: the message was probably dropped (page back to an empty chat?)')
        } else if (!s.generating && Date.now() - aliveAt > cfg.settle.maxWaitMs) {
          throw new ProviderError('timeout', 'no reply settled in time')
        } else if (Date.now() - startedAt > cfg.settle.maxWaitMs * HARD_CAP_FACTOR) {
          // A model that is still generating (stop button visible) is working, e.g. DeepSeek thinking for 10+ minutes before the first word: only an absolute cap stops it.
          throw new ProviderError('timeout', 'the model was still generating after the hard cap')
        }
        await sleep(pollMs)
      }
    },

    async selfTest(): Promise<SelfTestReport> {
      const c = getConfig()
      const want: Record<string, string | undefined> = {
        input: c.input,
        send: c.sendButton,
        assistant: c.assistantMessage,
        newChat: c.newChatButton,
        attach: c.attach?.open,
        trigger: c.model?.trigger,
        login: c.loginIndicator
      }
      const n = await run<Record<string, number>>(COUNT, { sels: want })
      const has = (k: string) => (n[k] ?? 0) > 0
      const checks: SelfTestReport['checks'] = [
        { name: 'input', ok: has('input') },
        { name: 'sendButton', ok: has('send') },
        // shortcut: stopButton is not checked, it exists only while the model generates
        { name: 'assistantMessage', ok: true, detail: has('assistant') ? undefined : 'nessun messaggio ancora' }
      ]
      if (c.newChatButton) checks.push({ name: 'newChatButton', ok: has('newChat') })
      if (c.attach?.open) checks.push({ name: 'attach.open', ok: has('attach') })
      if (c.model) checks.push({ name: 'model.trigger', ok: has('trigger') })
      if (c.loginIndicator)
        checks.push({ name: 'loginIndicator', ok: !has('login'), detail: has('login') ? 'presente: non connesso' : undefined })
      return { ok: checks.every((k) => k.ok), checks }
    }
  }
}
