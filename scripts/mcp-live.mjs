// Drives the MCP panel of the BUILT app (npm run build) end to end: paste a command, add it, test it, switch it off, remove it.
// The app runs with an empty data folder (FREEAGENT_DATA_DIR), so the real settings, servers and logins are never touched.
// It starts only tests/fixtures/echo-mcp.mjs; no provider is opened and nothing is downloaded. Usage: node scripts/mcp-live.mjs [out-dir]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const out = process.argv[2] ?? 'inspect-out'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'fa-mcp-live-'))
const hist = mkdtempSync(join(tmpdir(), 'fa-mcp-hist-'))
const echo = resolve('tests/fixtures/echo-mcp.mjs')

const electron = createRequire(import.meta.url)('electron')
const child = spawn(electron, ['.', '--remote-debugging-port=9342'], { env: { ...process.env, FREEAGENT_DATA_DIR: data, FREEAGENT_HISTORY_DIR: hist }, stdio: 'ignore' })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const check = (ok, what, extra = '') => {
  console.log(ok ? 'ok  ' : 'FAIL', what, extra)
  if (!ok) fails++
}
try {
  let ui
  for (let i = 0; i < 40 && !ui; i++) {
    await wait(1000)
    try {
      ui = (await (await fetch('http://127.0.0.1:9342/json')).json()).find((t) => t.type === 'page' && t.url.startsWith('file:'))
    } catch {
      /* starting */
    }
  }
  const ws = new WebSocket(ui.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (pend.has(m.id)) (pend.get(m.id)(m), pend.delete(m.id))
  }
  const call = (method, params = {}) =>
    new Promise((res) => {
      const my = ++id
      pend.set(my, res)
      ws.send(JSON.stringify({ id: my, method, params }))
    })
  const ev = async (e) => (await call('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.result.value
  const shot = async (name) => writeFileSync(join(out, `mcp-${name}.png`), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
  const click = (text) => ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`)
  const list = () => ev('window.api.listMcp().then((l) => JSON.stringify(l))').then(JSON.parse)
  const until = async (fn, ms = 20000) => {
    for (let t = 0; t < ms; t += 250) {
      if (await fn()) return true
      await wait(250)
    }
    return false
  }
  const rowOf = (name) => `[...document.querySelectorAll('details.mcp li')].find((l) => l.querySelector('strong')?.textContent === ${JSON.stringify(name)})`

  await wait(2000)
  await click('Strumenti')
  await wait(400)
  await ev("document.querySelector('details.mcp > summary')?.click()")
  await wait(2600)
  await shot('1-included')
  const first = await list()
  check(first.servers.some((s) => s.name === 'blender' && s.enabled && s.source === 'bundled'), 'the included server is listed and on', first.servers.map((s) => s.name).join(','))

  // quick add: set the textarea like a paste would
  await click('+ Aggiungi')
  await wait(300)
  const typed = await ev(`(() => {
    const t = document.querySelector('.mcp-add textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(t, ${JSON.stringify(`node "${echo}"`)})
    t.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check(typed, 'pasted a command line')
  check(await until(() => ev("document.querySelectorAll('.mcp-cand').length === 1")), 'one candidate was read', await ev("document.querySelector('.mcp-cand input[aria-label]')?.value ?? ''"))
  await shot('2-candidate')
  await click('Aggiungi server')
  check(await until(async () => (await list()).servers.some((s) => s.source === 'user')), 'the server was added')
  const added = (await list()).servers.find((s) => s.source === 'user')
  const name = added?.name ?? ''
  check(added?.enabled === true && !added.remote, 'it starts switched on and is not remote', JSON.stringify({ name, summary: added?.summary?.slice(0, 40) }))
  check(existsSync(join(data, 'mcp.user.json')), 'mcp.user.json was written in the data folder')

  // test it from the panel
  await ev(`${rowOf(name)}?.querySelector('.row-actions button')?.click()`)
  check(await until(() => ev("!!document.querySelector('.mcp-test.good')")), 'Prova: it works and lists its tool', await ev("document.querySelector('.mcp-test')?.textContent ?? ''"))
  await shot('3-tested')

  // switch it off
  await ev(`${rowOf(name)}?.querySelector('.switch input')?.click()`)
  check(await until(async () => (await list()).servers.find((s) => s.name === name)?.enabled === false), 'switched off')
  check(JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).mcpDisabled.includes(name), 'settings.json remembers it')
  await wait(2600)
  await shot('4-off')
  const off = await ev(`window.api.testMcp(${JSON.stringify(name)}).then((r) => JSON.stringify(r))`)
  check(JSON.parse(off).ok === true, 'a switched-off server can still be tried', off)

  // remove it (the confirm dialog is answered yes)
  await ev('window.confirm = () => true')
  await ev(`${rowOf(name)}?.querySelector('button.danger')?.click()`)
  check(await until(async () => !(await list()).servers.some((s) => s.source === 'user')), 'removed')
  check(!JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).mcpDisabled.includes(name), 'and forgotten by the switched-off list')
  const bad = await ev("window.api.removeMcp('blender').then(() => 'removed', (e) => String(e))")
  check(/cannot be removed/.test(bad), 'an included server cannot be removed', bad)
  console.log(fails ? `${fails} FAILED` : 'ALL OK', '- screenshots in', out)
} catch (e) {
  console.log('SCRIPT ERROR', String(e))
  fails++
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await wait(1000)
  process.exit(fails ? 1 : 0)
}
