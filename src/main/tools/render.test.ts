import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ToolContext } from '@contracts/agent'
import { createSandbox } from '../sandbox'
import { makeRenderTool, type Renderer } from './render'

let base: string
let ws: string
const ctx = (): ToolContext => {
  const sb = createSandbox(ws)
  return { cwd: sb.resolve('.', false), resolve: (p) => sb.resolve(p, false), checkpoint: async () => {} }
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'fa-render-')))
  ws = path.join(base, 'work')
  mkdirSync(path.join(ws, 'sub'), { recursive: true })
  for (const f of ['deck.pptx', 'old.ppt', 'sub/pagina.html', 'logo.svg', 'foto.png', 'doc.docx', 'Il mio deck (v2).pptx']) writeFileSync(path.join(ws, f), 'x')
  writeFileSync(path.join(base, 'fuori.pptx'), 'x')
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** Records what the tool asked for; answers like the real renderers. */
function fake() {
  const calls: { kind: string; src: string; out: string; o: unknown }[] = []
  const r: Renderer = {
    slides: async (src, outDir, o) => {
      calls.push({ kind: 'slides', src, out: outDir, o })
      return { files: [1, 2, 3].map((n) => path.join(outDir, `slide-0${n}.png`)), slides: 5, width: o.width, height: 720 }
    },
    page: async (src, outFile, o) => {
      calls.push({ kind: 'page', src, out: outFile, o })
      return { width: o.width, height: 2100 }
    }
  }
  return { calls, tool: makeRenderTool(r) }
}

describe('render', () => {
  it('una presentazione: chiede le slide al renderer, scrive sotto .freeagent/preview/<nome> e restituisce percorsi RELATIVI da dare a look', async () => {
    const { calls, tool } = fake()
    const out = await tool.run({ path: 'deck.pptx' }, ctx())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: 'slides', o: { width: 1280, maxSlides: 30 } })
    expect(calls[0]!.out).toBe(path.join(ws, '.freeagent', 'preview', 'deck'))
    expect(out).toContain('3 slides drawn at 1280x720')
    expect(out).toContain('the deck has 5 slides: raise "pages"')
    expect(out).toContain('.freeagent/preview/deck/slide-01.png')
    expect(out).not.toContain(base) // relative, never the absolute folder
  })

  it('pages e width arrivano al renderer; il nome della cartella e ripulito', async () => {
    const { calls, tool } = fake()
    await tool.run({ path: 'Il mio deck (v2).pptx', pages: 4, width: 800 }, ctx())
    expect(calls[0]).toMatchObject({ o: { width: 800, maxSlides: 4 } })
    expect(path.basename(calls[0]!.out)).toBe('Il_mio_deck_v2_')
  })

  it('una pagina html/svg: un solo PNG; le immagini sono gia immagini', async () => {
    const { calls, tool } = fake()
    const page = await tool.run({ path: 'sub/pagina.html' }, ctx())
    expect(calls[0]).toMatchObject({ kind: 'page' })
    expect(page).toContain('.freeagent/preview/pagina/page.png')
    expect(page).toContain('1280x2100')
    await tool.run({ path: 'logo.svg' }, ctx())
    expect(calls).toHaveLength(2)
    const img = await tool.run({ path: 'foto.png' }, ctx())
    expect(img).toContain('already an image')
    expect(calls).toHaveLength(2) // nothing was drawn
  })

  it('errori chiari: file assente, cartella, formato non gestito, fuori dalla cartella di lavoro', async () => {
    const { tool } = fake()
    await expect(tool.run({ path: 'non-esiste.pptx' }, ctx())).rejects.toThrow(/does not exist/)
    await expect(tool.run({ path: 'sub' }, ctx())).rejects.toThrow(/folder/)
    await expect(tool.run({ path: 'doc.docx' }, ctx())).rejects.toThrow(/cannot draw \.docx.*\.pptx/)
    await expect(tool.run({ path: '../fuori.pptx' }, ctx())).rejects.toThrow()
  })

  it('i permessi: una presentazione (la apre PowerPoint) conta come scrittura, html e immagini come lettura; i percorsi sono dichiarati', () => {
    const { tool } = fake()
    expect(tool.riskFor?.({ path: 'a.pptx' })).toBe('write')
    expect(tool.riskFor?.({ path: 'A.PPT' })).toBe('write')
    expect(tool.riskFor?.({ path: 'a.html' })).toBe('read')
    expect(tool.riskFor?.({ path: 'a.png' })).toBe('read')
    expect(tool.paths?.({ path: 'x/y.pptx' })).toEqual(['x/y.pptx'])
    expect(tool.schema.safeParse({ path: 'a.pptx', pages: 31 }).success).toBe(false)
    expect(tool.schema.safeParse({ path: 'a.pptx', width: 100 }).success).toBe(false)
  })
})
