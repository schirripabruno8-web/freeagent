import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportSlides } from '../src/main/render/pptx'

/**
 * REAL PowerPoint (COM, no window). Skipped when PowerPoint or python-pptx is missing on this machine. Takes ~10-30 s.
 */
const powerpoint = ['C:/Program Files/Microsoft Office/root/Office16/POWERPNT.EXE', 'C:/Program Files (x86)/Microsoft Office/root/Office16/POWERPNT.EXE'].some(existsSync)
const hasPptx = spawnSync('python', ['-c', 'import pptx'], { encoding: 'utf8' }).status === 0
const available = process.platform === 'win32' && powerpoint && hasPptx

let dir: string
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }))

const running = (): number => Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process POWERPNT -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8' }).trim())

describe.skipIf(!available)('PowerPoint vero: da .pptx a PNG', () => {
  it('esporta ogni slide in PNG veri, rispetta il tetto di slide, non lascia PowerPoint aperto e non tocca l\'originale', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'fa-pptx-'))
    const deck = path.join(dir, 'prova.pptx')
    const make = [
      'import sys',
      'from pptx import Presentation',
      'from pptx.util import Inches, Pt',
      'p = Presentation(); p.slide_width = Inches(13.333); p.slide_height = Inches(7.5)',
      'for i in range(3):',
      '    s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = "Slide %d" % (i + 1)',
      '    tb = s.shapes.add_textbox(Inches(1), Inches(2), Inches(8), Inches(2)); tb.text_frame.text = "Contenuto " * 8; tb.text_frame.paragraphs[0].font.size = Pt(28)',
      'p.save(sys.argv[1])'
    ].join('\n')
    writeFileSync(path.join(dir, 'make.py'), make)
    execFileSync('python', [path.join(dir, 'make.py'), deck])
    const before = readFileSync(deck)
    const wasRunning = running()

    const out = path.join(dir, 'out')
    const r = await exportSlides(deck, out, { width: 960 })
    expect(r.slides).toBe(3)
    expect(r.files.map((f) => path.basename(f))).toEqual(['slide-01.png', 'slide-02.png', 'slide-03.png'])
    expect(r.width).toBe(960)
    expect(r.height).toBe(540) // 16:9
    for (const f of r.files) {
      expect(statSync(f).size).toBeGreaterThan(2000)
      expect([...readFileSync(f).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]) // a real PNG
    }

    // a second run with a cap replaces the older images, it does not add to them
    const capped = await exportSlides(deck, out, { width: 640, maxSlides: 2 })
    expect(capped.files).toHaveLength(2)
    expect(capped.slides).toBe(3)

    expect(readFileSync(deck).equals(before)).toBe(true) // the original was never opened for writing
    // PowerPoint takes a moment to shut down after Quit: wait for it, up to 10 s
    for (let i = 0; i < 20 && running() !== wasRunning; i++) await new Promise((r) => setTimeout(r, 500))
    expect(running()).toBe(wasRunning) // closed again unless the user had it open
  }, 180_000)

  it('un file che non e una presentazione da un errore chiaro invece di bloccarsi', async () => {
    dir ??= mkdtempSync(path.join(tmpdir(), 'fa-pptx-'))
    const bad = path.join(dir, 'rotto.pptx')
    writeFileSync(bad, 'questo non e un pptx')
    await expect(exportSlides(bad, path.join(dir, 'out-bad'), { timeoutMs: 60_000 })).rejects.toThrow(/PowerPoint/)
  }, 90_000)
})
