import { JSDOM } from 'jsdom'
import type { Page } from '../../contracts/page'
import type { SelectorsConfig } from '../../contracts/selectors'

/** Page over JSDOM. evaluate runs the script through window.eval; goto reloads the HTML returned by load(url). */
export class JsdomPage implements Page {
  dom: JSDOM

  constructor(
    private readonly load: (url: string) => string,
    url: string
  ) {
    this.dom = this.open(url)
  }

  private open(url: string): JSDOM {
    return new JSDOM(this.load(url), { url, runScripts: 'outside-only' })
  }

  url(): string {
    return this.dom.window.location.href
  }

  async goto(url: string): Promise<void> {
    this.dom = this.open(url)
  }

  async evaluate<T = unknown>(script: string): Promise<T> {
    return (await this.dom.window.eval(script)) as T
  }

  /** Files given to attachFiles. Like the real page: `open` must click the upload entry; the "upload" then shows one `img.thumb` per file, a little later. */
  attached: string[][] = []

  async attachFiles(open: () => Promise<void>, paths: string[]): Promise<void> {
    await open()
    this.attached.push(paths)
    const doc = this.dom.window.document
    setTimeout(() => {
      for (const _p of paths) {
        const img = doc.createElement('img')
        img.className = 'thumb'
        doc.body.appendChild(img)
      }
    }, 40)
  }

  /** Writes into the focused element: value + input event for a textarea, textContent for contenteditable. */
  async insertText(text: string): Promise<void> {
    const el = this.dom.window.document.activeElement as HTMLElement | null
    if (el?.tagName === 'TEXTAREA') {
      const ta = el as HTMLTextAreaElement
      ta.value += text
      ta.dispatchEvent(new this.dom.window.Event('input', { bubbles: true }))
    } else if (el?.getAttribute('contenteditable') === 'true') {
      el.textContent = (el.textContent ?? '') + text
    } else {
      throw new Error('no editable element focused')
    }
  }
}

/**
 * Fake chat for the DeepSeek fixture. Enables send when the input has text; a send click clears the input and
 * streams `chunks` (HTML) into a new assistant message, showing the stop button meanwhile. No chunks = no reply.
 */
export function fakeChat(doc: Document, cfg: SelectorsConfig, chunks: string[], stepMs = 40): void {
  const input = doc.querySelector(cfg.input) as HTMLTextAreaElement
  const send = doc.querySelector(cfg.sendButton) as HTMLButtonElement
  const stop = doc.querySelector(cfg.stopButton!) as HTMLElement

  input.addEventListener('input', () => (send.disabled = !input.value.trim()))
  send.addEventListener('click', () => {
    send.disabled = true
    input.value = ''
    if (!chunks.length) return
    stop.hidden = false
    // The reply container appears only with the first chunk, so the previous message stays the last one until then.
    let msg: HTMLElement | undefined
    let i = 0
    const step = () => {
      const c = chunks[i++]
      if (c === undefined) {
        stop.hidden = true
        return
      }
      if (!msg) {
        msg = doc.createElement('div')
        msg.setAttribute('data-role', 'assistant')
        doc.querySelector('#messages')!.appendChild(msg)
      }
      msg.innerHTML += c
      setTimeout(step, stepMs)
    }
    setTimeout(step, stepMs)
  })

  if (cfg.model) {
    const trigger = doc.querySelector(cfg.model.trigger)!
    for (const o of doc.querySelectorAll(cfg.model.option)) {
      o.addEventListener('click', () => (trigger.textContent = o.textContent))
    }
  }
}

export function showToast(doc: Document, text: string): void {
  doc.querySelector('#toasts')!.textContent = text
}
