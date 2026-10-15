import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SelectorsConfig } from '../contracts/selectors'
import { createSelectorAdapter } from '../src/main/providers/selector-adapter'
import { loadSelectors } from '../src/main/providers/load-selectors'
import { JsdomPage, fakeChat, showToast } from './helpers/jsdom-page'

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const fixture = (name: string) => readFileSync(path(`../fixtures/deepseek/${name}`), 'utf8')
const base = loadSelectors(path('../fixtures/deepseek/selectors.fixture.json'))
// Short settle so the tests run in milliseconds; the real values live in the JSON.
const cfg = (over: Partial<SelectorsConfig> = {}): SelectorsConfig => ({
  ...base,
  settle: { idleMs: 50, maxWaitMs: 1000 },
  ...over
})

function setup(html: string, c: SelectorsConfig = cfg()) {
  const page = new JsdomPage(() => html, c.url)
  const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, domQuietMs: 0 })
  return { page, adapter }
}

const doc = (page: JsdomPage) => page.dom.window.document

async function collect(stream: AsyncIterable<{ text: string; done: boolean }>) {
  const out: { text: string; done: boolean }[] = []
  for await (const s of stream) out.push(s)
  return out
}

// What the reply fixture's last message must become: fences exact, toolbar and hidden span dropped.
const REPLY = 'Leggo il file.\nUso `read` con\nquesto argomento:\n```json\n{"tool":"read","args":{"path":"notes.txt"}}\n```'

describe('estrazione testo', () => {
  it('ricostruisce il markdown: fence esatti, toolbar Copy e nodi nascosti esclusi', async () => {
    const { adapter } = setup(fixture('chat-reply.html'))
    const snaps = await collect(adapter.stream())
    expect(snaps.at(-1)).toEqual({ text: REPLY, done: true })
  })

  it('liste e pre senza <code>: il testo dei button e ignorato', async () => {
    const html = fixture('chat.html').replace(
      '<main id="messages"></main>',
      '<main id="messages"><div data-role="assistant"><ul><li>a</li><li>b</li></ul>' +
        '<pre><div><button>Copy</button></div>x\ny</pre></div></main>'
    )
    const { adapter } = setup(html)
    const snaps = await collect(adapter.stream())
    expect(snaps.at(-1)).toEqual({ text: '- a\n- b\n```\nx\ny\n```', done: true })
  })
})

describe('send e stream', () => {
  it('stream completo: snapshot che crescono, poi done finale', async () => {
    const c = cfg()
    const { page, adapter } = setup(fixture('chat.html'), c)
    fakeChat(doc(page), c, ['<p>Uno</p>', '<p>Due</p>'])
    await adapter.send('ciao')
    const snaps = await collect(adapter.stream())
    expect(snaps.at(-1)).toEqual({ text: 'Uno\nDue', done: true })
    expect(snaps.slice(0, -1).every((s) => !s.done)).toBe(true)
    expect(snaps.every((s) => 'Uno\nDue'.startsWith(s.text))).toBe(true)
  })

  it('un messaggio assistant precedente alla send non e la risposta nuova', async () => {
    const c = cfg()
    const { page, adapter } = setup(fixture('chat-reply.html'), c)
    fakeChat(doc(page), c, ['<p>Risposta nuova</p>'])
    await adapter.send('ciao')
    const snaps = await collect(adapter.stream())
    expect(snaps.some((s) => s.text.includes('Leggo il file'))).toBe(false)
    expect(snaps.at(-1)).toEqual({ text: 'Risposta nuova', done: true })
  })

  it('toast di rate limit -> ProviderError rate_limit', async () => {
    const c = cfg()
    const { page, adapter } = setup(fixture('chat.html'), c)
    fakeChat(doc(page), c, ['<p>x</p>'])
    await adapter.send('ciao')
    showToast(doc(page), 'Rate limit reached, try again later')
    await expect(collect(adapter.stream())).rejects.toMatchObject({ name: 'ProviderError', kind: 'rate_limit' })
  })

  it('nessuna risposta entro maxWaitMs -> timeout', async () => {
    const c = cfg({ settle: { idleMs: 50, maxWaitMs: 100 } })
    const { page, adapter } = setup(fixture('chat.html'), c)
    fakeChat(doc(page), c, [])
    await adapter.send('ciao')
    await expect(collect(adapter.stream())).rejects.toMatchObject({ name: 'ProviderError', kind: 'timeout' })
  })

  it('abort durante lo stream -> aborted', async () => {
    const c = cfg()
    const { page, adapter } = setup(fixture('chat.html'), c)
    fakeChat(doc(page), c, ['<p>Uno</p>', '<p>Due</p>'])
    await adapter.send('ciao')
    const ac = new AbortController()
    const consume = async () => {
      for await (const _snap of adapter.stream(ac.signal)) ac.abort()
    }
    await expect(consume()).rejects.toMatchObject({ kind: 'aborted' })
  })
})

describe('stato generazione', () => {
  it('stop nascosto da una regola CSS non conta come generazione', async () => {
    const { adapter } = setup(fixture('chat-reply-css-hidden.html'))
    const snaps = await collect(adapter.stream())
    expect(snaps.at(-1)).toEqual({ text: 'Risposta completata.', done: true })
  })

  it('done non prima di idleMs dall ultimo cambio di testo', async () => {
    const { adapter } = setup(fixture('chat-reply.html'), cfg({ settle: { idleMs: 150, maxWaitMs: 1000 } }))
    const t0 = Date.now()
    const snaps = await collect(adapter.stream())
    expect(snaps.at(-1)?.done).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
  })
})

describe('status', () => {
  it('loggato, sconosciuto, sloggato', async () => {
    const { page, adapter } = setup(fixture('chat.html'))
    expect(await adapter.status()).toEqual({ loggedIn: true, url: 'https://chat.deepseek.com/' })

    doc(page).body.insertAdjacentHTML('beforeend', '<div data-testid="login">Accedi</div>')
    expect(await adapter.status()).toEqual({
      loggedIn: false,
      url: 'https://chat.deepseek.com/',
      error: 'login_required'
    })

    const blank = setup('<html><body></body></html>').adapter
    expect((await blank.status()).loggedIn).toBe('unknown')
  })
})

describe('selfTest', () => {
  it('pagina chat: tutti i check ok, nessun messaggio ancora', async () => {
    const { adapter } = setup(fixture('chat.html'))
    const r = await adapter.selfTest()
    expect(r.ok).toBe(true)
    expect(r.checks.find((c) => c.name === 'assistantMessage')?.detail).toBe('nessun messaggio ancora')
  })

  it('selettore rotto -> check falso e ok globale false', async () => {
    const { adapter } = setup(fixture('chat.html'), cfg({ sendButton: "[data-testid='nope']" }))
    const r = await adapter.selfTest()
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.name === 'sendButton')?.ok).toBe(false)
  })

  it('loginIndicator presente -> check falso', async () => {
    const { page, adapter } = setup(fixture('chat.html'))
    doc(page).body.insertAdjacentHTML('beforeend', '<div data-testid="login">Accedi</div>')
    expect((await adapter.selfTest()).ok).toBe(false)
  })
})

describe('modelli', () => {
  it('listModels: id da data-value, label dal testo', async () => {
    const c = cfg()
    const { page, adapter } = setup(fixture('chat.html'), c)
    fakeChat(doc(page), c, [])
    expect(await adapter.listModels()).toEqual([
      { id: 'deepseek-chat', label: 'DeepSeek V3' },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1' }
    ])
  })

  it('selectModel per label e per id; id sconosciuto -> errore', async () => {
    const c = cfg()
    const { page, adapter } = setup(fixture('chat.html'), c)
    fakeChat(doc(page), c, [])
    const trigger = () => doc(page).querySelector("[data-testid='model-trigger']")?.textContent

    await adapter.selectModel('DeepSeek R1')
    expect(trigger()).toBe('DeepSeek R1')
    await adapter.selectModel('deepseek-chat')
    expect(trigger()).toBe('DeepSeek V3')
    await expect(adapter.selectModel('nope')).rejects.toMatchObject({ kind: 'selector_broken' })
  })

  it('senza cfg.model: lista vuota, selectModel errore', async () => {
    const { adapter } = setup(fixture('chat.html'), cfg({ model: undefined }))
    expect(await adapter.listModels()).toEqual([])
    await expect(adapter.selectModel('x')).rejects.toMatchObject({ kind: 'selector_broken' })
  })
})

describe('newChat', () => {
  it('senza newChatButton ricarica la URL del provider', async () => {
    let loads = 0
    const c = cfg({ newChatButton: undefined })
    const page = new JsdomPage(() => {
      loads++
      return fixture('chat.html')
    }, c.url)
    const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, domQuietMs: 0 })
    await adapter.newChat()
    expect(loads).toBe(2)
  })

  it('con newChatButton clicca il bottone', async () => {
    const c = cfg()
    const { page, adapter } = setup(fixture('chat.html'), c)
    let clicked = false
    doc(page)
      .querySelector(c.newChatButton!)!
      .addEventListener('click', () => (clicked = true))
    await adapter.newChat()
    expect(clicked).toBe(true)
  })
})

describe('immagini', () => {
  const attach = { open: '#plus', choose: '#up', ready: 'img.thumb' }
  // The upload entry exists only after the "+" is clicked (a menu), like on Qwen.
  function withMenu(cfgOver: Partial<SelectorsConfig> = { attach }) {
    const c = cfg(cfgOver)
    const page = new JsdomPage(() => fixture('chat.html').replace('<form>', '<form><button type="button" id="plus">+</button>'), c.url)
    const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, menuSettleMs: 0, domQuietMs: 0 })
    const d = doc(page)
    const order: string[] = []
    d.querySelector('#plus')!.addEventListener('click', () => {
      order.push('plus')
      const item = d.createElement('div')
      item.id = 'up'
      item.addEventListener('click', () => order.push('up'))
      d.body.appendChild(item)
    })
    d.querySelector('#chat-input')!.addEventListener('input', () => order.push('typed'))
    fakeChat(d, c, ['<p>Vista</p>'])
    return { page, adapter, order }
  }

  it('apre il menu, sceglie "carica", consegna i file, aspetta le miniature e SOLO DOPO scrive il testo', async () => {
    const { page, adapter, order } = withMenu()
    await adapter.send('guarda', ['D:/img/a.png', 'D:/img/b.jpg'])
    expect(order).toEqual(['plus', 'up', 'typed'])
    expect(page.attached).toEqual([['D:/img/a.png', 'D:/img/b.jpg']])
    expect(doc(page).querySelectorAll('img.thumb').length).toBe(2) // send did not go before the uploads were ready
    expect((await collect(adapter.stream())).at(-1)).toEqual({ text: 'Vista', done: true })
  })

  it('senza immagini il menu non si tocca', async () => {
    const { page, adapter, order } = withMenu()
    await adapter.send('ciao')
    await adapter.send('ancora', [])
    expect(order).toEqual(['typed', 'typed'])
    expect(page.attached).toEqual([])
  })

  it('provider senza attach: errore chiaro e niente scritto nel campo', async () => {
    const { page, adapter } = setup(fixture('chat.html'))
    await expect(adapter.send('guarda', ['D:/img/a.png'])).rejects.toMatchObject({ kind: 'selector_broken', message: expect.stringMatching(/no attach selectors/) })
    expect((doc(page).querySelector('#chat-input') as HTMLTextAreaElement).value).toBe('')
  })

  it('bottone "+" assente o voce "carica" che non compare: errore, niente file consegnati e il messaggio non parte', async () => {
    const noPlus = withMenu({ attach: { ...attach, open: '#manca' } })
    await expect(noPlus.adapter.send('guarda', ['D:/img/a.png'])).rejects.toThrow(/attach button not found/)
    const noItem = withMenu({ attach: { ...attach, choose: '#manca' } })
    await expect(noItem.adapter.send('guarda', ['D:/img/a.png'])).rejects.toThrow(/attach menu entry not found/)
    expect(noPlus.page.attached).toEqual([])
    expect(noItem.page.attached).toEqual([])
    expect(noPlus.order).toEqual([])
  })

  it('selfTest controlla il bottone di apertura solo se configurato', async () => {
    const ok = await withMenu().adapter.selfTest()
    expect(ok.checks.find((k) => k.name === 'attach.open')?.ok).toBe(true)
    const bad = await setup(fixture('chat.html'), cfg({ attach })).adapter.selfTest()
    expect(bad.ok).toBe(false)
    expect((await setup(fixture('chat.html')).adapter.selfTest()).checks.some((k) => k.name === 'attach.open')).toBe(false)
  })
})

describe('editor di codice (Monaco) e menu modelli con descrizione', () => {
  const monaco =
    '<div class="msg"><p>Ecco:</p><pre class="code"><div class="hdr"><div>python</div><button>Copy</button></div>' +
    '<div class="body"><div class="view-line" style="top:20px"><span>&nbsp;&nbsp;&nbsp;&nbsp;print(i)</span></div>' +
    '<div class="view-line" style="top:0px"><span>for i in range(1, 151):</span></div></div></pre></div>'

  it('codeLines: righe in ordine di top, nbsp in spazi, banner e numeri di riga fuori; senza codeLines resta il testo del pre', async () => {
    const c = cfg({ assistantMessage: '.msg', codeLang: '.hdr > div:first-child', codeLines: '.view-line' })
    const { adapter } = setup(`<body>${monaco}</body>`, c)
    expect((await collect(adapter.stream())).at(-1)).toEqual({ text: 'Ecco:\n```python\nfor i in range(1, 151):\n    print(i)\n```', done: true })
    const plain = setup(`<body>${monaco}</body>`, cfg({ assistantMessage: '.msg' }))
    expect((await collect(plain.adapter.stream())).at(-1)!.text).toContain('print(i)')
  })

  const menu =
    '<body><div id="t">Qwen3.8-Max</div><div class="opt"><div class="n">Qwen3.7-Plus</div><div>Set as default</div><p>descrizione lunga</p></div>' +
    '<div class="opt"><div class="n">Qwen3.8-Max</div><div>Cancel default</div></div></body>'

  it('model.label: id e label sono il nome, non tutto il testo della voce; selectModel sceglie per nome', async () => {
    const c = cfg({ model: { trigger: '#t', option: '.opt', label: '.n' } })
    const { page, adapter } = setup(menu, c)
    expect(await adapter.listModels()).toEqual([
      { id: 'Qwen3.7-Plus', label: 'Qwen3.7-Plus' },
      { id: 'Qwen3.8-Max', label: 'Qwen3.8-Max' }
    ])
    let clicked = ''
    for (const o of doc(page).querySelectorAll('.opt')) o.addEventListener('click', () => (clicked = o.querySelector('.n')!.textContent!))
    await adapter.selectModel('Qwen3.7-Plus')
    expect(clicked).toBe('Qwen3.7-Plus')
    await expect(adapter.selectModel('Qwen9')).rejects.toThrow(/not offered/)
  })
})

describe('pagina ancora in caricamento', () => {
  it('newChat aspetta che la pagina smetta di cambiare: il campo c\'e\' subito, i menu e i bottoni dopo', async () => {
    const c = cfg({ newChatButton: '#new' })
    const page = new JsdomPage(() => fixture('chat.html').replace('<form>', '<form><button type="button" id="new">nuova</button>'), c.url)
    const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, domQuietMs: 100 })
    const d = doc(page)
    // like an SPA still booting: the page keeps changing for ~200 ms after the click
    d.querySelector('#new')!.addEventListener('click', () => {
      for (let i = 1; i <= 5; i++) setTimeout(() => d.body.appendChild(d.createElement('div')).classList.add('late'), i * 40)
    })
    const n = d.querySelectorAll('div').length
    const t0 = Date.now()
    await adapter.newChat()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(d.querySelectorAll('div.late').length).toBe(5) // returned only after the last change
    expect(d.querySelectorAll('div').length).toBe(n + 5)
  })
})

describe('modello che pensa a lungo', () => {
  it('finche\' il tasto stop e\' visibile il modello sta lavorando: nessun timeout anche oltre maxWaitMs senza testo', async () => {
    const c = cfg({ settle: { idleMs: 50, maxWaitMs: 150 } })
    const { page, adapter } = setup(fixture('chat.html'), c)
    const d = doc(page)
    fakeChat(d, c, [])
    await adapter.send('pensa')
    const stop = d.querySelector(c.stopButton!) as HTMLElement
    stop.hidden = false // thinking: stop visible, no answer text yet, for longer than maxWaitMs
    setTimeout(() => {
      const m = d.createElement('div')
      m.setAttribute('data-role', 'assistant')
      m.innerHTML = '<p>Pronto</p>'
      d.querySelector('#messages')!.appendChild(m)
      stop.hidden = true
    }, 400)
    expect((await collect(adapter.stream())).at(-1)).toEqual({ text: 'Pronto', done: true })
  })

  it('senza tasto stop e senza testo il timeout resta quello di maxWaitMs', async () => {
    const c = cfg({ settle: { idleMs: 50, maxWaitMs: 150 } })
    const { page, adapter } = setup(fixture('chat.html'), c)
    fakeChat(doc(page), c, [])
    await adapter.send('muto')
    await expect(collect(adapter.stream())).rejects.toMatchObject({ kind: 'timeout' })
  })
})

describe('messaggio scartato dal sito', () => {
  it('se dopo l\'invio non compare ne\' testo ne\' tasto stop entro startGraceMs: errore subito, non dopo maxWaitMs', async () => {
    const c = cfg({ settle: { idleMs: 50, maxWaitMs: 60_000 } })
    const page = new JsdomPage(() => fixture('chat.html'), c.url)
    const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, domQuietMs: 0, startGraceMs: 120 })
    fakeChat(doc(page), c, []) // the site accepts the send and then nothing happens
    await adapter.send('ciao')
    const t0 = Date.now()
    await expect(collect(adapter.stream())).rejects.toMatchObject({ kind: 'interrupted', message: expect.stringMatching(/never started answering/) })
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('un modello che pensa (tasto stop visibile) non viene scambiato per un messaggio scartato', async () => {
    const c = cfg({ settle: { idleMs: 50, maxWaitMs: 60_000 } })
    const page = new JsdomPage(() => fixture('chat.html'), c.url)
    const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, domQuietMs: 0, startGraceMs: 120 })
    const d = doc(page)
    fakeChat(d, c, [])
    await adapter.send('pensa')
    const stop = d.querySelector(c.stopButton!) as HTMLElement
    stop.hidden = false
    setTimeout(() => {
      const m = d.createElement('div')
      m.setAttribute('data-role', 'assistant')
      m.innerHTML = '<p>Ecco</p>'
      d.querySelector('#messages')!.appendChild(m)
      stop.hidden = true
    }, 400)
    expect((await collect(adapter.stream())).at(-1)).toEqual({ text: 'Ecco', done: true })
  })
})

describe('splash di caricamento', () => {
  it('newChat aspetta che lo splash visibile sparisca anche se il campo di testo c\'e\' gia; uno splash nascosto non blocca', async () => {
    const c = cfg({ loading: '#splash' })
    const page = new JsdomPage(() => fixture('chat.html').replace('<form>', '<div id="splash">carico</div><form>'), c.url)
    const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, domQuietMs: 0 })
    const d = doc(page)
    setTimeout(() => d.querySelector('#splash')!.remove(), 300)
    const t0 = Date.now()
    await adapter.newChat()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280)
    expect(d.querySelector('#splash')).toBeNull()

    const hiddenPage = new JsdomPage(() => fixture('chat.html').replace('<form>', '<div id="splash" hidden>carico</div><form>'), c.url)
    const t1 = Date.now()
    await createSelectorAdapter(hiddenPage, () => c, { pollMs: 10, domQuietMs: 0 }).newChat()
    expect(Date.now() - t1).toBeLessThan(250)
  })
})

describe('ragionamento visibile (DeepSeek) come segno di vita', () => {
  const think = (d: Document, over: string) => {
    const el = d.createElement('div')
    el.className = 'think'
    d.body.appendChild(el)
    return { el, grow: (t: string) => (el.textContent = (el.textContent ?? '') + t), over }
  }

  it('senza tasto stop riconosciuto, un ragionamento che cresce evita sia lo startGrace sia maxWaitMs; la risposta arriva dopo', async () => {
    const c = cfg({ thinking: '.think', settle: { idleMs: 50, maxWaitMs: 150 } })
    const page = new JsdomPage(() => fixture('chat.html'), c.url)
    const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, domQuietMs: 0, startGraceMs: 120 })
    const d = doc(page)
    fakeChat(d, c, [])
    await adapter.send('pensa')
    const t = think(d, '')
    const iv = setInterval(() => t.grow('.'), 40) // grows for ~480 ms: 4x startGraceMs and 3x maxWaitMs
    setTimeout(() => {
      clearInterval(iv)
      const m = d.createElement('div')
      m.setAttribute('data-role', 'assistant')
      m.innerHTML = '<p>Risposta</p>'
      d.querySelector('#messages')!.appendChild(m)
    }, 480)
    expect((await collect(adapter.stream())).at(-1)).toEqual({ text: 'Risposta', done: true })
  })

  it('un ragionamento fermo non e un segno di vita: messaggio scartato = errore entro startGraceMs', async () => {
    const c = cfg({ thinking: '.think', settle: { idleMs: 50, maxWaitMs: 60_000 } })
    const page = new JsdomPage(() => fixture('chat.html'), c.url)
    const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, domQuietMs: 0, startGraceMs: 120 })
    const d = doc(page)
    fakeChat(d, c, [])
    think(d, '').grow('vecchio ragionamento di un turno precedente')
    await adapter.send('ciao')
    await expect(collect(adapter.stream())).rejects.toMatchObject({ kind: 'interrupted', message: expect.stringMatching(/never started answering/) })
  })
})

describe('risposta interrotta dal sito', () => {
  it('ragionamento che smette di crescere, niente stop e niente risposta: interrupted entro stallMs, senza aspettare maxWaitMs', async () => {
    const c = cfg({ thinking: '.think', settle: { idleMs: 50, maxWaitMs: 60_000 } })
    const page = new JsdomPage(() => fixture('chat.html'), c.url)
    const adapter = createSelectorAdapter(page, () => c, { pollMs: 10, domQuietMs: 0, startGraceMs: 60_000, stallMs: 150 })
    const d = doc(page)
    fakeChat(d, c, [])
    await adapter.send('pensa')
    const el = d.createElement('div')
    el.className = 'think'
    d.body.appendChild(el)
    let n = 0
    const iv = setInterval(() => {
      el.textContent = 'x'.repeat(++n)
      if (n === 5) clearInterval(iv) // the site gives up after 5 chunks of reasoning
    }, 30)
    const t0 = Date.now()
    await expect(collect(adapter.stream())).rejects.toMatchObject({ kind: 'interrupted', message: expect.stringMatching(/while reasoning/) })
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('scelta obbligatoria del sito (confronto A/B di Qwen)', () => {
  const withChoice = (c: SelectorsConfig) => {
    const html = fixture('chat.html').replace('</body>', '<button class="prefer" disabled>1</button><button class="prefer" disabled>2</button></body>')
    const { page, adapter } = setup(html, c)
    const d = doc(page)
    const btns = [...d.querySelectorAll('.prefer')] as HTMLButtonElement[]
    const clicks: string[] = []
    btns.forEach((b, i) =>
      b.addEventListener('click', () => {
        clicks.push(`${i + 1}:${b.disabled ? 'disabled' : 'enabled'}`)
        btns.forEach((x) => x.remove())
        const m = d.querySelector('[data-role=assistant]')
        if (m) m.innerHTML = `<p>Scelta ${i + 1}</p>`
      })
    )
    return { page, adapter, d, btns, clicks }
  }

  it('finche i bottoni sono visibili la risposta non e finita; quando si abilitano ne clicca UNO (il primo) e legge la risposta scelta', async () => {
    const c = cfg({ dismiss: '.prefer' })
    const { adapter, d, btns, clicks } = withChoice(c)
    fakeChat(d, c, ['<p>Uno</p>'])
    await adapter.send('ciao')
    setTimeout(() => btns.forEach((b) => (b.disabled = false)), 300) // answers complete: the buttons wake up
    const snaps = await collect(adapter.stream())
    expect(clicks).toEqual(['1:enabled']) // never while disabled, only once, the first one
    expect(snaps.at(-1)).toEqual({ text: 'Scelta 1', done: true })
  })

  it('prima di un invio, una scelta in sospeso viene fatta subito', async () => {
    const c = cfg({ dismiss: '.prefer' })
    const { adapter, d, btns, clicks } = withChoice(c)
    fakeChat(d, c, ['<p>Ok</p>'])
    btns.forEach((b) => (b.disabled = false))
    d.querySelector('#chat-input')!.addEventListener('input', () => clicks.push('typed'))
    await adapter.send('avanti')
    expect(clicks).toEqual(['1:enabled', 'typed'])
  })

  it('senza dismiss configurato il comportamento non cambia', async () => {
    const c = cfg()
    const { adapter, d, btns, clicks } = withChoice(c)
    fakeChat(d, c, ['<p>Uno</p>'])
    btns.forEach((b) => (b.disabled = false))
    await adapter.send('ciao')
    expect((await collect(adapter.stream())).at(-1)).toEqual({ text: 'Uno', done: true })
    expect(clicks).toEqual([])
  })
})
