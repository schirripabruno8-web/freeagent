import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const HTML_EXT = /\.(html?|svg)$/i

/**
 * Draws a local HTML/SVG file in a hidden window and saves it as PNG (no window ever shows). The window cannot reach the network:
 * the page was written by a model, so only file:, data: and blob: requests are let through.
 */
export async function shootHtml(file: string, outFile: string, o: { width?: number; maxHeight?: number; timeoutMs?: number } = {}): Promise<{ width: number; height: number }> {
  const { width = 1280, maxHeight = 6000, timeoutMs = 20_000 } = o
  // Imported here, not at the top: this module is also loaded by tests, where `electron` is only a path.
  const { BrowserWindow, session } = (await import('electron')) as unknown as typeof import('electron')
  const ses = session.fromPartition(`fa-render-${Math.random().toString(36).slice(2)}`) // not persistent: nothing is kept
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|data|blob):/i.test(d.url) }))
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  // A sandboxed window fails (and crashes) when an SVG is the document itself: an <img> inside a page draws it, and runs none of its scripts.
  let target = file
  let wrapper: string | undefined
  if (/\.svg$/i.test(file)) {
    wrapper = join(tmpdir(), `fa-svg-${Math.random().toString(36).slice(2)}.html`)
    await writeFile(wrapper, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff"><img src="${pathToFileURL(file).href}" style="display:block;width:100%;height:auto">`)
    target = wrapper
  }
  const win = new BrowserWindow({
    show: false,
    width,
    height: 720,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  try {
    await Promise.race([win.loadFile(target), new Promise((_, rej) => setTimeout(() => rej(new Error(`the page did not load within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs))])
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true')
    await new Promise((r) => setTimeout(r, 350)) // scripts and animations get a moment to settle
    const full = Number(await win.webContents.executeJavaScript('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, document.documentElement.getBoundingClientRect().height))'))
    const height = Math.min(Math.max(Math.round(full) || 720, 200), maxHeight)
    win.setContentSize(width, height)
    await new Promise((r) => setTimeout(r, 200))
    const shot = await win.webContents.capturePage()
    await mkdir(dirname(outFile), { recursive: true })
    await writeFile(outFile, shot.toPNG())
    return shot.getSize() // real pixels: a 125% display makes them more than the CSS size asked for
  } finally {
    win.destroy()
    if (wrapper) await rm(wrapper, { force: true })
  }
}
