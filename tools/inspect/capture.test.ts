import { describe, expect, it } from 'vitest'
import { AutoCapture, composerSignature } from './capture'
import type { DomReport } from './inspect-script'

// Solo il bottone di invio conta per la firma: il resto del report resta vuoto.
const report = (svgSig: string, disabled = false): DomReport => ({
  origin: 'https://chat.deepseek.com',
  candidates: {
    input: [],
    sendButton: [{ selector: 'button', classes: [], svgSig, ariaLabel: null, type: null, disabled, svgOnly: true }],
    assistantMessage: [],
    markdownContainers: [],
    controls: [],
    modelSelector: { triggers: [], options: [] },
    errorRegions: []
  },
  loginIndicator: false,
  composer: null,
  messageTrees: [],
  tree: { tag: 'body' }
})

const SEND = 'M1 1'
const STOP = 'M2 2'

describe('composerSignature', () => {
  it('cambia tra invio, stop e disabilitato', () => {
    expect(composerSignature(report(SEND))).not.toBe(composerSignature(report(STOP)))
    expect(composerSignature(report(SEND, true))).not.toBe(composerSignature(report(SEND)))
  })
})

describe('AutoCapture', () => {
  it('il primo snapshot si tiene come first', () => {
    const c = new AutoCapture()
    expect(c.push(report(SEND), 0)).toEqual({ keep: true, reason: 'first' })
    expect(c.kept()).toEqual([expect.objectContaining({ atMs: 0, reason: 'first' })])
  })

  it('stesso segnale ripetuto non si tiene', () => {
    const c = new AutoCapture()
    c.push(report(SEND), 0)
    expect(c.push(report(SEND), 1500)).toEqual({ keep: false, reason: null })
    expect(c.kept()).toHaveLength(1)
  })

  it('cambio di segnale si tiene', () => {
    const c = new AutoCapture()
    c.push(report(SEND), 0)
    expect(c.push(report(STOP), 1500)).toEqual({ keep: true, reason: 'composer-change' })
  })

  it('ritorno al segnale iniziale si tiene di nuovo (cambio rispetto all\'ultimo tenuto)', () => {
    const c = new AutoCapture()
    c.push(report(SEND), 0)
    c.push(report(STOP), 1500)
    expect(c.push(report(SEND), 3000)).toEqual({ keep: true, reason: 'composer-change' })
    expect(c.kept()).toHaveLength(3)
  })

  it('oltre maxKept i cambi sono scartati', () => {
    const c = new AutoCapture({ maxKept: 2 })
    c.push(report(SEND), 0)
    c.push(report(STOP), 1500)
    expect(c.push(report(SEND), 3000)).toEqual({ keep: false, reason: null })
    expect(c.kept()).toHaveLength(2)
  })

  it('finish con lo stesso oggetto gia\' tenuto non duplica', () => {
    const c = new AutoCapture()
    const first = report(SEND)
    c.push(first, 0)
    c.finish(first, 1500)
    expect(c.kept()).toHaveLength(1)
  })

  it('finish aggiunge final anche se uguale all\'ultimo tenuto', () => {
    const c = new AutoCapture()
    c.push(report(SEND), 0)
    c.finish(report(SEND), 1500)
    expect(c.kept().map((k) => k.reason)).toEqual(['first', 'final'])
  })

  it('finish aggiunge final anche oltre il limite', () => {
    const c = new AutoCapture({ maxKept: 1 })
    c.push(report(SEND), 0)
    const end = report(STOP)
    expect(c.push(end, 1500)).toEqual({ keep: false, reason: null })
    c.finish(end, 3000)
    expect(c.kept().map((k) => k.reason)).toEqual(['first', 'final'])
  })
})
