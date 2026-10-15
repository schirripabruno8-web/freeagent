import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ToolContext } from '@contracts/agent'
import { createSandbox } from '../sandbox'
import { makeLookTool, reviewPrompt } from './look'

let base: string
let ws: string
const ctx = (): ToolContext => {
  const sb = createSandbox(ws)
  return { cwd: sb.resolve('.', false), resolve: (p) => sb.resolve(p, false), checkpoint: async () => {} }
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-look-')))
  ws = path.join(base, 'work')
  mkdirSync(path.join(ws, 'prev'), { recursive: true })
  for (const f of ['prev/slide-01.png', 'prev/slide-02.png', 'a.JPG', 'nota.txt']) writeFileSync(path.join(ws, f), 'x')
  writeFileSync(path.join(ws, 'enorme.png'), '')
  truncateSync(path.join(ws, 'enorme.png'), 10 * 1024 * 1024 + 1)
  writeFileSync(path.join(base, 'fuori.png'), 'x')
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

function tool(answer = 'Slide 2: il titolo esce dal bordo.') {
  const asked: { images: string[]; prompt: string }[] = []
  const t = makeLookTool(async (images, prompt) => (asked.push({ images, prompt }), answer))
  return { t, asked }
}

describe('look', () => {
  it('manda percorsi ASSOLUTI e il prompt di revisione con la domanda; il verdetto torna come testo', async () => {
    const { t, asked } = tool()
    const out = await t.run({ images: ['prev/slide-01.png', 'prev/slide-02.png', 'a.JPG'], question: 'Il testo esce dalle slide?' }, ctx())
    expect(out).toBe('Vision verdict:\nSlide 2: il titolo esce dal bordo.')
    expect(asked[0]!.images).toEqual([path.join(ws, 'prev', 'slide-01.png'), path.join(ws, 'prev', 'slide-02.png'), path.join(ws, 'a.JPG')])
    expect(asked[0]!.prompt).toContain('QUESTION: Il testo esce dalle slide?')
    expect(asked[0]!.prompt).toContain('numbered 1 to 3')
    expect(asked[0]!.prompt).toContain('never invent')
    expect(asked[0]!.prompt).toContain('do not suggest style or taste changes') // no endless polishing loops
  })

  it('con una sola immagine il prompt non parla di numeri; risposta vuota = messaggio che dice di verificare altrove', async () => {
    expect(reviewPrompt('ok?', 1)).not.toContain('numbered')
    const { t } = tool('   ')
    expect(await t.run({ images: ['a.JPG'], question: 'ok?' }, ctx())).toContain('gave no answer')
  })

  it('rifiuta cio che non e un\'immagine, un file assente, uno troppo grande e un percorso fuori dalla cartella; non chiama mai il modello', async () => {
    const { t, asked } = tool()
    await expect(t.run({ images: ['nota.txt'], question: 'q' }, ctx())).rejects.toThrow(/not a png\/jpg\/webp\/gif/)
    await expect(t.run({ images: ['manca.png'], question: 'q' }, ctx())).rejects.toThrow(/does not exist/)
    await expect(t.run({ images: ['enorme.png'], question: 'q' }, ctx())).rejects.toThrow(/over 10 MB/)
    await expect(t.run({ images: ['../fuori.png'], question: 'q' }, ctx())).rejects.toThrow()
    expect(asked).toEqual([])
  })

  it('schema: da 1 a 4 immagini, domanda non vuota; i percorsi sono dichiarati ai permessi; e una lettura', () => {
    const { t } = tool()
    expect(t.schema.safeParse({ images: [], question: 'q' }).success).toBe(false)
    expect(t.schema.safeParse({ images: ['a', 'b', 'c', 'd', 'e'], question: 'q' }).success).toBe(false)
    expect(t.schema.safeParse({ images: ['a'], question: '' }).success).toBe(false)
    expect(t.schema.safeParse({ images: ['a', 'b', 'c', 'd'], question: 'q' }).success).toBe(true)
    expect(t.paths?.({ images: ['x.png', 'y.png'], question: 'q' })).toEqual(['x.png', 'y.png'])
    expect(t.risk).toBe('read')
  })
})
