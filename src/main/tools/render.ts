import { stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolDef } from '@contracts/agent'
import { HTML_EXT, shootHtml } from '../render/html'
import { exportSlides, PPTX_EXT } from '../render/pptx'

/** What turns a file into pictures. Injected so the tool can be tested without PowerPoint or a window. */
export interface Renderer {
  slides(src: string, outDir: string, o: { width: number; maxSlides: number }): Promise<{ files: string[]; slides: number; width: number; height: number }>
  page(src: string, outFile: string, o: { width: number }): Promise<{ width: number; height: number }>
}

export const defaultRenderer: Renderer = { slides: exportSlides, page: shootHtml }

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i

const schema = z.object({
  path: z.string(),
  pages: z.number().int().min(1).max(30).optional(),
  width: z.number().int().min(400).max(2400).optional()
})
type Args = z.infer<typeof schema>

/**
 * Pictures of a file, made in the background (no window is shown), saved under `.freeagent/preview/` in the workspace:
 * the app's own scratch folder, so the permission gate treats the HTML/image cases as plain reads. A presentation is
 * opened by PowerPoint, which is more than reading: that case counts as a write.
 */
export function makeRenderTool(r: Renderer): ToolDef<Args> {
  return {
    name: 'render',
    description:
      'Draw a file as PNG screenshots in the background, to check how it really looks: the slides of a .pptx/.ppt/.odp (drawn by PowerPoint), or a page of an .html/.svg file. Returns the PNG paths: pass them to look.',
    argsHint: '{"path": string, "pages"?: int (max 30), "width"?: int (default 1280)}',
    schema,
    risk: 'read',
    riskFor: (a) => (PPTX_EXT.test(a.path) ? 'write' : 'read'),
    paths: (a) => [a.path],
    summary: (a) => `render ${a.path}`,
    async run({ path: p, pages = 30, width = 1280 }, ctx) {
      const src = ctx.resolve(p)
      const st = await stat(src).catch(() => undefined)
      if (!st) throw new Error(`${p} does not exist`)
      if (!st.isFile()) throw new Error(`${p} is a folder: render takes a file`)
      const rel = (f: string): string => path.relative(ctx.cwd, f).split(path.sep).join('/')
      if (IMAGE_EXT.test(src)) return `${p} is already an image: pass it to look as it is.`

      const base = path.basename(src, path.extname(src)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'file'
      const outDir = path.join(ctx.cwd, '.freeagent', 'preview', base)
      if (PPTX_EXT.test(src)) {
        const x = await r.slides(src, outDir, { width, maxSlides: pages })
        const more = x.slides > x.files.length ? ` (the deck has ${x.slides} slides: raise "pages" to see the rest)` : ''
        return `${x.files.length} slide${x.files.length === 1 ? '' : 's'} drawn at ${x.width}x${x.height}${more}:\n${x.files.map(rel).join('\n')}\nNext: look at them (up to 4 images per call).`
      }
      if (HTML_EXT.test(src)) {
        const out = path.join(outDir, 'page.png')
        const x = await r.page(src, out, { width })
        return `Page drawn at ${x.width}x${x.height}:\n${rel(out)}\nNext: look at it.`
      }
      throw new Error(`render cannot draw ${path.extname(src) || 'this file'}. It handles .pptx .ppt .pps .ppsx .odp (PowerPoint), .html .htm .svg (a page), and images (used as they are)`)
    }
  }
}

export const renderTool = makeRenderTool(defaultRenderer)
