import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { INSPECT_SCRIPT, type DomReport, type TreeNode } from './inspect-script'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8')
// JSON round trip: come arriva davvero da webContents.executeJavaScript (e verifica la serializzabilita').
const run = (html: string): DomReport => {
  const dom = new JSDOM(html, { url: 'https://chat.deepseek.com/', runScripts: 'outside-only' })
  return JSON.parse(JSON.stringify(dom.window.eval(INSPECT_SCRIPT)))
}
const count = (n: TreeNode): number => 1 + (n.kids ?? []).reduce((s, k) => s + count(k), 0)
const depth = (n: TreeNode): number => 1 + Math.max(0, ...(n.kids ?? []).map((k) => depth(k)))

describe('inspect-script su pagina chat', () => {
  const r = run(fixture('chat.html'))

  it('origin e solo scheme + host', () => {
    expect(r.origin).toBe('https://chat.deepseek.com')
  })

  it('input: la textarea visibile, il contenteditable nascosto no', () => {
    expect(r.candidates.input).toEqual([
      expect.objectContaining({ selector: '#prompt', tag: 'textarea', placeholder: 'Chiedi qualcosa', ariaLabel: 'Messaggio' })
    ])
  })

  it('bottone invio solo-svg e disabilitato, dentro 3 livelli dall\'input', () => {
    expect(r.candidates.sendButton).toContainEqual(
      expect.objectContaining({ selector: '[data-testid="send"]', ariaLabel: 'Invia', svgOnly: true, disabled: true })
    )
  })

  it('messaggi assistant: gruppo di 3 fratelli, user escluso', () => {
    expect(r.candidates.assistantMessage).toContainEqual({
      parent: '[data-testid="conv"]',
      childSelector: 'div.msg[data-message-author-role="assistant"]',
      children: 3,
      classes: ["msg"],
      hasPre: true
    })
  })

  it('selettore modello e voci del menu visibili', () => {
    expect(r.candidates.modelSelector.triggers).toContainEqual(
      expect.objectContaining({ selector: '[data-testid="model"]', text: 'DeepSeek-V3' })
    )
    expect(r.candidates.modelSelector.options.map((o) => o.text)).toEqual(['DeepSeek-V3', 'DeepSeek-R1'])
  })

  it('toast di errore: solo la lunghezza del testo', () => {
    expect(r.candidates.errorRegions).toContainEqual(expect.objectContaining({ role: 'alert', textChars: 16 }))
  })

  it('loginIndicator false sulla chat', () => {
    expect(r.loginIndicator).toBe(false)
  })

  it('PRIVACY: nessun titolo, href, messaggio, value o titolo pagina nel report', () => {
    const json = JSON.stringify(r)
    for (const secret of ['SEGRETO-TITOLO-CHAT', 'SEGRETO-MESSAGGIO', 'SEGRETO-HREF', 'SEGRETO-TITOLO-PAGINA', 'SEGRETO-PASSWORD']) {
      expect(json).not.toContain(secret)
    }
  })
})

describe('inspect-script su pagina di login', () => {
  const r = run(fixture('login.html'))

  it('loginIndicator true con input password', () => {
    expect(r.loginIndicator).toBe(true)
  })

  it('PRIVACY: il value del campo password non esce', () => {
    expect(JSON.stringify(r)).not.toContain('SEGRETO-PASSWORD')
  })
})

describe('limiti del tree', () => {
  it('al massimo 800 nodi', () => {
    expect(count(run('<body>' + '<i></i>'.repeat(1500) + '</body>').tree)).toBeLessThanOrEqual(800)
  })

  it('al massimo 16 livelli', () => {
    expect(depth(run('<body>' + '<div>'.repeat(30) + '</div>'.repeat(30) + '</body>').tree)).toBeLessThanOrEqual(16)
  })
})

describe('inspect-script: titoli di chat nella sidebar', () => {
  it('non escono ne\' come testo ne\' come aria-label, ma i controlli fuori sidebar si', () => {
    const html = `<body><nav><button aria-label="SEGRETO-ARIA">SEGRETO-BOTTONE</button>
      <div aria-label="SEGRETO-DIV">x</div></nav>
      <aside class="x"><a aria-label="SEGRETO-LINK" href="/c/1">SEGRETO-LINK-TESTO</a></aside>
      <div class="sidebar-wrap"><div role="menuitem" aria-label="SEGRETO-MENU">SEGRETO-VOCE</div></div>
      <main><textarea id="prompt" aria-label="Messaggio"></textarea><button aria-label="Invia">Invia</button></main></body>`
    const out = JSON.stringify(run(html))
    expect(out).not.toContain('SEGRETO')
    expect(out).toContain('Invia')
  })
})

describe('inspect-script: composer, messaggi, controlli', () => {
  const html = `<body><nav><p>SEGRETO-NAV</p></nav>
    <main><div class="chat"><div class="msg"><p>SEGRETO-RISPOSTA</p><pre><code class="language-python">SEGRETO-CODICE</code></pre></div></div>
    <div class="radio" role="radiogroup"><div role="radio" aria-checked="true">Expert</div><div role="radio" aria-checked="false">Instant</div></div>
    <div class="box"><div class="in"><textarea id="prompt"></textarea><div class="ds-button primary" role="button"><svg><path d="M1 2 3 4"/></svg></div></div></div></main></body>`
  const r = run(html)
  it('un solo messaggio: contenitore markdown trovato senza testo', () => {
    expect(r.candidates.markdownContainers).toEqual([
      expect.objectContaining({ selector: 'div.msg', count: 2 })
    ])
    expect(JSON.stringify(r)).not.toContain('SEGRETO')
  })
  it('controlli radio con stato; composer con il bottone di invio e la firma della icona', () => {
    expect(r.candidates.controls).toEqual([
      expect.objectContaining({ role: 'radio', state: 'true', text: 'Expert' }),
      expect.objectContaining({ role: 'radio', state: 'false', text: 'Instant' })
    ])
    expect(JSON.stringify(r.composer)).toContain('ds-button')
    expect(r.candidates.sendButton[0]).toMatchObject({ classes: ['ds-button', 'primary'], svgSig: 'M1 2 3 4' })
  })
})
