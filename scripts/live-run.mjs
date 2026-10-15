// Dev helper: starts the app (built with `npm run build`) with a debug port, runs ONE task through the same API the UI uses and prints every event.
// This sends real messages from the logged-in provider accounts. Usage: node scripts/live-run.mjs <provider> <cwd> "<task>" [image] [timeoutMin]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
const [provider, cwd, task, image, timeoutMin = '20'] = process.argv.slice(2)
const electron = createRequire(import.meta.url)('electron')
const port = 9336
const logFile = process.env['LIVE_LOG'] // full events (JSON lines), for analysing a run afterwards
if (logFile) writeFileSync(logFile, '')
const env = { ...process.env, ...(image ? { FREEAGENT_TEST_IMAGES: image } : {}) }
// LIVE_EXE=release/win-unpacked/FreeAgent.exe tests the packaged app instead of `electron .`
const child = process.env['LIVE_EXE'] ? spawn(process.env['LIVE_EXE'], [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' }) : spawn(electron, ['.', `--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let ws
let id = 0
const pend = new Map()
const cdp = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails).slice(0, 500))
  return r.result.result.value
}
try {
  let ui
  for (let i = 0; i < 40 && !ui; i++) {
    await wait(1500)
    try {
      ui = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && t.url.startsWith('file:'))
    } catch {
      /* the app is still starting */
    }
  }
  if (!ui) throw new Error('the app UI never appeared on the debug port')
  await wait(2000)
  ws = new WebSocket(ui.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id) pend.get(j.id)?.(j) }
  await ev(`(() => { window.__ev = []; window.api.onEvent((e) => window.__ev.push(e)); window.api.onApproval((a) => { window.__ev.push({ type: 'APPROVAL', a }); window.api.answerApproval(a.id, true) }); return true })()`)
  await ev(`window.api.setMode('full')`)
  // LIVE_OPEN=<history id> shows that chat first and LIVE_RESUME=1 sends the task as a follow-up in it ("Continua")
  if (process.env['LIVE_OPEN']) console.log('opened:', await ev(`window.api.openHistory(${JSON.stringify(process.env['LIVE_OPEN'])}).then((m) => m.title)`))
  const imgs = image ? await ev(`window.api.pickImages()`) : []
  console.log('images:', JSON.stringify(imgs))
  await ev(`window.api.startTask(${JSON.stringify(task)}, ${JSON.stringify({ provider, cwd, ...(imgs.length ? { images: imgs } : {}), ...(process.env['LIVE_RESUME'] ? { resume: true } : {}) })}).then(() => 'started')`)
  console.log('task started')
  let seen = 0
  const t0 = Date.now()
  for (;;) {
    await wait(3000)
    const evs = JSON.parse(await ev(`JSON.stringify(window.__ev.slice(${seen}))`))
    for (const e of evs) {
      if (logFile && !(e.type === 'assistant' && !e.done)) appendFileSync(logFile, JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), ...e }) + '\n')
      if (e.type === 'assistant' && !e.done) continue // streaming snapshots: only the finished reply is worth a line
      const body = e.text ?? e.message ?? e.summary ?? (e.report && e.report.summary) ?? (e.call && JSON.stringify(e.call)) ?? (e.a && JSON.stringify(e.a)) ?? ''
      console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${e.type}${e.agent ? '(' + e.agent + ')' : ''} ${String(body).replace(/\s+/g, ' ').slice(0, 220)}`)
    }
    seen += evs.length
    if (evs.some((e) => e.type === 'finished' && !e.agent)) break
    if (Date.now() - t0 > Number(timeoutMin) * 60_000) { console.log('TIMEOUT'); break }
  }
} catch (e) {
  console.log('SCRIPT ERROR', String(e))
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await wait(1500)
  process.exit(0)
}
