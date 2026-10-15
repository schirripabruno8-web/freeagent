import { app, BrowserWindow, Menu, dialog } from 'electron'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AutoCapture } from './capture'
import { INSPECT_SCRIPT, type DomReport } from './inspect-script'

interface Provider {
  id: string
  label: string
  url: string
}

// Same profile as the app (see src/main/index.ts), so a login done here is the login the app uses.
app.setPath('userData', join(app.getPath('appData'), 'freeagent'))

const providers = JSON.parse(readFileSync(join(process.cwd(), 'config/providers.json'), 'utf8')) as Provider[]
const providerId = process.argv.slice(2).find((a) => !a.startsWith('-'))
const provider = providers.find((p) => p.id === providerId)

function openInspector(p: Provider): void {
  // Nessun preload: la partition e' la stessa dell'app, cosi' il login resta.
  const win = new BrowserWindow({
    width: 1200,
    height: 850,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: `persist:${p.id}` }
  })
  const ses = win.webContents.session
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) win.loadURL(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('https://')) e.preventDefault()
  })

  const save = (mode: 'idle' | 'generating') => async () => {
    try {
      const report = await win.webContents.executeJavaScript(INSPECT_SCRIPT)
      const dir = join(process.cwd(), 'inspect-out')
      const file = join(dir, `${p.id}.${mode}.json`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, JSON.stringify({ ...report, mode, provider: p.id, savedAt: new Date().toISOString() }, null, 2))
      await dialog.showMessageBox(win, { message: 'DOM salvato', detail: file })
    } catch (err) {
      dialog.showErrorBox('Salvataggio fallito', String(err))
    }
  }

  // Cattura senza tempismo: campiona ogni 1.5 s, AutoCapture tiene solo gli stati che cambiano.
  let autoRunning = false
  const autoCapture = async () => {
    if (autoRunning) return
    autoRunning = true
    try {
      await dialog.showMessageBox(win, {
        message: "Parte la cattura automatica per 2 minuti. Scrivi un messaggio lungo al modello (es. 'conta da 1 a 150, un numero per riga, poi un blocco di codice python'), aspetta la risposta, poi scrivine un secondo. Non servono altri tasti."
      })
      const cap = new AutoCapture()
      const t0 = Date.now()
      let last: { report: DomReport; atMs: number } | null = null
      while (Date.now() - t0 < 120_000) {
        try {
          const report: DomReport = await win.webContents.executeJavaScript(INSPECT_SCRIPT)
          last = { report, atMs: Date.now() - t0 }
          cap.push(report, last.atMs)
        } catch {
          // Tick fallito (pagina in navigazione o in caricamento): il tick successivo riprova.
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
      if (last) cap.finish(last.report, last.atMs)
      const dir = join(process.cwd(), 'inspect-out')
      mkdirSync(dir, { recursive: true })
      for (const f of readdirSync(dir)) if (f.startsWith(`${p.id}.auto.`) && f.endsWith('.json')) rmSync(join(dir, f))
      const kept = cap.kept()
      const savedAt = new Date().toISOString()
      kept.forEach((k, i) =>
        writeFileSync(join(dir, `${p.id}.auto.${i + 1}.json`), JSON.stringify({ ...k.report, mode: 'auto', provider: p.id, savedAt, reason: k.reason, atMs: k.atMs }, null, 2))
      )
      writeFileSync(join(dir, `${p.id}.auto.index.json`), JSON.stringify(kept.map((k, i) => ({ n: i + 1, atMs: k.atMs, reason: k.reason })), null, 2))
      await dialog.showMessageBox(win, { message: `Cattura finita: ${kept.length + 1} file in inspect-out. Allegali TUTTI (compreso index)` })
    } catch (err) {
      dialog.showErrorBox('Cattura fallita', String(err))
    } finally {
      autoRunning = false
    }
  }

  // Edit serve: senza, Ctrl+V non incolla nella chat del provider.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Inspect',
        submenu: [
          { label: 'Salva DOM (idle)', accelerator: 'CommandOrControl+Shift+1', click: save('idle') },
          { label: 'Salva DOM (sta generando)', accelerator: 'CommandOrControl+Shift+2', click: save('generating') },
          { label: 'Cattura automatica (2 min)', accelerator: 'CommandOrControl+Shift+3', click: autoCapture }
        ]
      },
      { role: 'editMenu' }
    ])
  )
  win.loadURL(p.url)
}

app.whenReady().then(() => {
  if (!provider) {
    const msg = `Provider "${providerId ?? ''}" non trovato. Disponibili: ${providers.map((p) => p.id).join(', ')}`
    console.error(msg)
    dialog.showErrorBox('Provider mancante', msg)
    return app.exit(1)
  }
  openInspector(provider)
})
