import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SelectorsConfig } from '../contracts/selectors'
import { ProviderError } from '../contracts/provider'
import { parseReply } from '../src/main/agent/parser'
import { loadSelectors } from '../src/main/providers/load-selectors'
import { createSelectorAdapter } from '../src/main/providers/selector-adapter'
import { JsdomPage } from './helpers/jsdom-page'

// The REAL config/selectors/deepseek.json against a fixture shaped like the page `npm run inspect` saw.
const file = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const html = readFileSync(file('../fixtures/deepseek/real-conversation.html'), 'utf8')
const real = loadSelectors(file('../config/selectors/deepseek.json'))
const cfg: SelectorsConfig = { ...real, settle: { idleMs: 60, maxWaitMs: 1500 } }

const STOP_D = 'M2 4.88C2 3.68009 2 3.08013 2.30557 2.65'
const SEND_D = 'M8.3125 0.980206C8.66767 1.05312 8.97902'

/** The page behaves like DeepSeek: send is "disabled" by class until the textarea has text; one button swaps its icon to stop. */
function wire(page: JsdomPage, reply: () => void, ms = 60) {
  const doc = page.dom.window.document
  const input = doc.querySelector('textarea') as HTMLTextAreaElement
  const send = doc.querySelector('#send') as HTMLElement
  const path = send.querySelector('path') as SVGPathElement
  // React updates the class a tick AFTER the input event: send() must wait for it, not click at once
  input.addEventListener('input', () => setTimeout(() => send.classList.toggle('ds-button--disabled', !input.value.trim()), 40))
  send.addEventListener('click', () => {
    if (send.classList.contains('ds-button--disabled')) return // a real disabled button swallows the click
    input.value = ''
    send.classList.add('ds-button--disabled')
    path.setAttribute('d', STOP_D)
    setTimeout(() => {
      reply()
      path.setAttribute('d', SEND_D)
    }, ms)
  })
}

const collect = async (it: AsyncIterable<{ text: string; done: boolean }>) => {
  const out: { text: string; done: boolean }[] = []
  for await (const s of it) out.push(s)
  return out
}

describe('config reale di DeepSeek su una pagina con la sua struttura', () => {
  it('selfTest: input, invio, messaggio e login assente risolvono', async () => {
    const page = new JsdomPage(() => html, 'https://chat.deepseek.com/')
    const r = await createSelectorAdapter(page, () => cfg, { pollMs: 10 }).selfTest()
    expect(r.checks.filter((c) => !c.ok)).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('la risposta esce come markdown: fence con lingua dal banner, niente ragionamento ne\' bottoni', async () => {
    const page = new JsdomPage(() => html, 'https://chat.deepseek.com/')
    const adapter = createSelectorAdapter(page, () => cfg, { pollMs: 10 })
    // the old reply is already on the page: it must NOT be taken for the answer, so add a new one after send
    const doc = page.dom.window.document
    const first = doc.querySelector('.ds-message') as HTMLElement
    wire(page, () => first.parentElement!.appendChild(first.cloneNode(true)))
    await adapter.send('ciao')
    const snaps = await collect(adapter.stream())
    const text = snaps.at(-1)!.text
    expect(snaps.at(-1)!.done).toBe(true)
    expect(text).toBe('Ecco il comando:\n```tool\n{"tool": "read",\n  "args": {"path": "a.txt"}}\n```')
    for (const noise of ['TESTO-DEL-RAGIONAMENTO', 'Copia', 'Scarica', 'COPIA-RISPOSTA']) expect(text).not.toContain(noise)
    const parsed = parseReply(text, { final: true })
    expect(parsed.kind === 'calls' && parsed.calls[0]).toMatchObject({ tool: 'read', args: { path: 'a.txt' } })
  })

  it('il bottone resta "disabilitato" finche\' non c\'e\' testo: send() aspetta e non clicca a vuoto', async () => {
    const page = new JsdomPage(() => html, 'https://chat.deepseek.com/')
    const adapter = createSelectorAdapter(page, () => cfg, { pollMs: 10 })
    const doc = page.dom.window.document
    const first = doc.querySelector('.ds-message') as HTMLElement
    wire(page, () => first.parentElement!.appendChild(first.cloneNode(true)))
    await adapter.send('x') // would throw 'message was not sent' if it clicked before the class was removed
    expect((await collect(adapter.stream())).at(-1)!.done).toBe(true)
  })

  it('lista virtualizzata: il vecchio messaggio sparisce e ne arriva uno nuovo, stesso numero', async () => {
    const page = new JsdomPage(() => html, 'https://chat.deepseek.com/')
    const adapter = createSelectorAdapter(page, () => cfg, { pollMs: 10 })
    const doc = page.dom.window.document
    wire(page, () => {
      const old = doc.querySelector('.ds-message') as HTMLElement
      const fresh = old.cloneNode(true) as HTMLElement
      fresh.querySelector('.ds-assistant-message-main-content p span')!.textContent = 'Nuova risposta'
      old.replaceWith(fresh) // count stays 1
    })
    await adapter.send('altro')
    const last = (await collect(adapter.stream())).at(-1)!
    expect(last.text).toContain('Nuova risposta')
  })

  it('non connesso: status false e newChat lancia login_required (non selector_broken)', async () => {
    const loggedOut = '<body><form><input type="password"></form></body>'
    const page = new JsdomPage(() => loggedOut, 'https://chat.deepseek.com/sign_in')
    const adapter = createSelectorAdapter(page, () => cfg, { pollMs: 10 })
    expect(await adapter.status()).toMatchObject({ loggedIn: false, error: 'login_required' })
    await expect(adapter.newChat()).rejects.toMatchObject({ kind: 'login_required' } satisfies Partial<ProviderError>)
  })
})
