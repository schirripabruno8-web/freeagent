// Dev helper: starts the app (built with `npm run build`) with FAKE events and a made-up chat history in a temp folder, and screenshots the UI.
// Nothing here sends a message to a provider or touches the real history. Usage: node scripts/ui-shots.mjs [out-dir]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'inspect-out'
mkdirSync(out, { recursive: true })

// ---- made-up history ----
const hist = mkdtempSync(join(tmpdir(), 'fa-shots-'))
const now = Date.now()
const H = 3600 * 1000
const meta = (id, title, ago, over = {}) => ({ id, provider: 'qwen', cwd: 'D:\\pistol', title, startedAt: now - ago, updatedAt: now - ago, status: 'done', summary: 'Fatto.', runs: 1, ...over })
const metas = [
  meta('a1', "Ricrea in Blender la pistola dell'immagine allegata: forma, materiali procedurali, dettagli e interni.", 25 * 60_000, { runs: 2, summary: 'Caricatore allungato di 2 cm, pistola.blend e anteprima.png aggiornati.' }),
  meta('a2', 'Quanti anagrammi distinti ha la parola ABRACADABRA?', 26 * H, { provider: 'deepseek', cwd: 'D:\\progetti\\FreeAgent', summary: '83160' }),
  meta('a3', 'Leggi BRIEF.md e segui le istruzioni.', 3 * 24 * H, { status: 'error', summary: 'timeout: no reply settled in time' }),
  meta('a4', 'Usa il tool delegate una volta: crea un cubo in Blender', 12 * 24 * H, { cwd: 'D:\\progetti\\PistolaTest', summary: 'Il sub-agente modeler ha creato il cubo.' })
]
writeFileSync(join(hist, 'index.json'), JSON.stringify(metas))
const conv = [
  { type: 'user', text: "Ricrea in Blender la pistola dell'immagine allegata: forma, materiali procedurali, dettagli e interni.", images: 1 },
  { type: 'status', text: 'new chat' },
  { type: 'assistant', text: 'Leggo il brief.\n```tool\n{"tool": "read", "args": {"path": "BRIEF.md"}}\n```', done: true },
  { type: 'tool_call', call: { id: '1.1', tool: 'read', args: { path: 'BRIEF.md' } } },
  { type: 'tool_result', id: '1.1', ok: true, output: '# Compito: ricreare questa pistola in Blender\n...' },
  { type: 'assistant', text: 'Divido il lavoro in tre parti e le delego al modeler.', done: true },
  { type: 'tool_call', call: { id: '2.1', tool: 'delegate', args: { agent: 'modeler', task: 'Crea il carrello (slide) della pistola in Blender con bpy.' } }, },
  { type: 'assistant', text: 'Creo il carrello con uno script bpy.', done: true, agent: 'modeler-1' },
  { type: 'tool_call', call: { id: '1.1', tool: 'mcp_call', args: { server: 'blender', tool: 'execute_python', arguments: { code: 'import bpy' } } }, agent: 'modeler-1' },
  { type: 'tool_result', id: '1.1', ok: true, output: '{"success": true}', agent: 'modeler-1' },
  { type: 'tool_result', id: '2.1', ok: true, output: 'Slide creato: D:/pistol/slide.blend' },
  { type: 'finished', report: { reason: 'finish', summary: 'Pistola 3D ricreata e assemblata in D:\\pistol\\pistola.blend con anteprima.', steps: 9 } },
  { type: 'user', text: 'Il caricatore è troppo corto: allungalo di 2 cm e rigenera pistola.blend.', resume: true },
  { type: 'assistant', text: 'Allungo il caricatore e rigenero il file.', done: true },
  { type: 'finished', report: { reason: 'finish', summary: 'Caricatore allungato di 2 cm, pistola.blend e anteprima.png aggiornati.', steps: 3 } }
]
writeFileSync(join(hist, 'a1.json'), JSON.stringify(conv))
for (const m of metas.slice(1)) writeFileSync(join(hist, `${m.id}.json`), JSON.stringify([{ type: 'user', text: m.title }, { type: 'finished', report: { reason: m.status === 'error' ? 'error' : 'finish', summary: m.summary, steps: 2 } }]))

// ---- app ----
const electron = createRequire(import.meta.url)('electron')
const child = spawn(electron, ['.', '--remote-debugging-port=9341', '--inspect=9340'], { env: { ...process.env, FREEAGENT_HISTORY_DIR: hist }, stdio: 'ignore' })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const get = async (port) => (await fetch('http://127.0.0.1:' + port + '/json')).json()
const conn = async (url) => {
  const ws = new WebSocket(url)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (pend.has(m.id)) (pend.get(m.id)(m), pend.delete(m.id))
  }
  return { call: (method, params = {}) => new Promise((res) => { const my = ++id; pend.set(my, res); ws.send(JSON.stringify({ id: my, method, params })) }) }
}
try {
  let ui
  for (let i = 0; i < 40 && !ui; i++) {
    await wait(1000)
    try { ui = (await get(9341)).find((t) => t.type === 'page' && t.url.startsWith('file:')) } catch { /* starting */ }
  }
  const main = (await get(9340))[0]
  const U = await conn(ui.webSocketDebuggerUrl)
  const M = await conn(main.webSocketDebuggerUrl)
  const shot = async (name) => {
    const r = await U.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(out + '/ui-' + name + '.png', Buffer.from(r.result.data, 'base64'))
  }
  const send = async (ch, payload) => {
    const expr = "process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.send(" + JSON.stringify(ch) + ', ' + JSON.stringify(payload) + ')'
    await M.call('Runtime.evaluate', { expression: expr, returnByValue: true })
  }
  const ev = async (e) => (await U.call('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.result.value
  const click = (text) => ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`)
  const E = (e) => send('fa:event', e)

  await wait(2500)
  await shot('1-empty')
  // a conversation
  for (const e of conv.slice(0, 11)) await E(e)
  await E({ type: 'agent', id: 'main', name: 'main', provider: 'qwen', status: 'running' })
  await E({ type: 'agent', id: 'modeler-1', name: 'modeler', provider: 'deepseek', status: 'running' })
  await E({ type: 'agent', id: 'modeler-2', name: 'modeler', provider: 'deepseek', status: 'queued' })
  await E({ type: 'assistant', text: 'Ora delego il telaio. Preparo il comando:\n```tool\n{"tool": "delegate", "args": {"agent": "modeler", "task": "Crea il telaio', done: false })
  await wait(400)
  await shot('2-chat')
  await E({ type: 'error', kind: 'interrupted', message: 'the provider stopped while reasoning, without an answer (server error?)' })
  await E({ type: 'finished', report: { reason: 'finish', summary: 'Pistola 3D ricreata e assemblata.', steps: 9 } })
  await wait(300)
  await click('Modifica')
  await wait(300)
  await shot('3-options')
  await click('Recenti')
  await wait(800)
  await shot('4-history')
  await ev("document.querySelector('.chat-card .open')?.click()")
  await wait(1500)
  await shot('5-opened-chat')
  await click('Strumenti')
  await wait(500)
  await ev("document.querySelector('details.mcp > summary')?.click()")
  await wait(300)
  await shot('6-tools')
  await click('Task')
  await send('fa:approval', { id: 'x', kind: 'write', tool: 'edit', summary: 'edit src/a.ts', detail: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n const b = 3\n', outside: false, agent: 'modeler-1' })
  await wait(500)
  await shot('7-approval')
  console.log('screenshots in', out)
} catch (e) {
  console.log('SCRIPT ERROR', String(e))
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await wait(1000)
  process.exit(0)
}
