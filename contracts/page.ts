/** What an adapter may do to a web page. Electron implements it over a WebContentsView; tests over jsdom. */
export interface Page {
  url(): string
  goto(url: string): Promise<void>
  /** Runs a script (a JS expression, e.g. an IIFE) in the page and returns its JSON-serialisable result. Awaits promises. */
  evaluate<T = unknown>(script: string): Promise<T>
  /** Types text into the currently focused element the way a user would (Electron: webContents.insertText). */
  insertText(text: string): Promise<void>
  /** Focuses the page, runs `open` (it must end by clicking the page's own upload control, so a file dialog opens) and answers that dialog with these files, as if the user chose them. Throws if no dialog opens. */
  attachFiles(open: () => Promise<void>, paths: string[]): Promise<void>
}
