import type { WebContentsView } from 'electron'
import type { Page } from '@contracts/page'

/** Page over a provider's WebContentsView. Scripts run in the page's main world (the page is the provider; no Node there). */
export function electronPage(view: WebContentsView): Page {
  const wc = view.webContents
  return {
    url: () => wc.getURL(),
    goto: async (url) => {
      try {
        await wc.loadURL(url)
      } catch (e) {
        if ((e as { code?: string }).code !== 'ERR_ABORTED') throw e // redirects abort the first load
      }
    },
    evaluate: (script) => wc.executeJavaScript(script, true),
    insertText: async (text) => {
      wc.focus()
      await wc.insertText(text)
    },
    // The page opens its file dialog (from a click `open` makes): the debugger swallows the dialog and fills the input the page made for it with the files,
    // which fires the page's own `change` handler. A static <input type=file> in the DOM is NOT what the page listens to. Attached only for the call.
    attachFiles: async (open, paths) => {
      // An unfocused view (the app's panel has the focus) does not open the page's menus or its file dialog.
      wc.focus()
      await new Promise((r) => setTimeout(r, 300))
      const dbg = wc.debugger
      const own = !dbg.isAttached()
      if (own) dbg.attach('1.3')
      let onMsg: ((e: unknown, method: string, params: { backendNodeId?: number }) => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const opened = new Promise<number>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('no file dialog opened')), 10_000)
          onMsg = (_e, method, params) => {
            if (method === 'Page.fileChooserOpened' && params.backendNodeId) resolve(params.backendNodeId)
          }
          dbg.on('message', onMsg)
        })
        opened.catch(() => {}) // if open() throws first, the timeout rejection must not go unhandled
        await dbg.sendCommand('Page.enable')
        await dbg.sendCommand('DOM.enable')
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
        await open()
        await dbg.sendCommand('DOM.setFileInputFiles', { files: paths, backendNodeId: await opened })
      } finally {
        clearTimeout(timer)
        if (onMsg) dbg.removeListener('message', onMsg)
        if (own) dbg.detach()
      }
    }
  }
}
