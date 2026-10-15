// Dev helper: starts the PACKAGED exe on a debug port, checks the preload API and the bundled config/skills, then stops only that process.
// It never calls anything that writes settings (no setMode/setPonytail with a valid value) and never starts a task.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const exe = 'release/win-unpacked/FreeAgent.exe'
if (!existsSync(exe)) throw new Error(exe + ' not found: run npm run pack')
const child = spawn(exe, ['--remote-debugging-port=9335'], { stdio: 'ignore' })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  await wait(8000)
  const targets = await (await fetch('http://127.0.0.1:9335/json')).json()
  const ui = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'))
  const ws = new WebSocket(ui.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  const ev = (e) =>
    new Promise((r) => {
      ws.onmessage = (m) => {
        const j = JSON.parse(m.data)
        if (j.id === 1) r(j.result.result.value)
      }
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } }))
    })
  console.log('api functions:', await ev('Object.keys(window.api).length'))
  console.log('skills:', await ev("window.api.listSkills().then(s => s.map(x => x.name + ':' + x.source).join(' '))"))
  console.log('ponytail level:', await ev('window.api.getPonytail()'))
  console.log("setPonytail('turbo'):", await ev("window.api.setPonytail('turbo').then(() => 'ACCEPTED', () => 'rejected')"))
  console.log('ready providers:', await ev("window.api.listProviders().then(p => p.filter(x => x.ready).map(x => x.id).join(',')) "))
  console.log('models:', await ev('window.api.listModels().then(m => m.length)'))
  console.log('mcp servers:', await ev("window.api.listMcp().then(l => l.servers.map(x => x.name + ':' + x.mode).join(' '))"))
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await wait(1000)
}
console.log('bundled ponytail:', existsSync('release/win-unpacked/resources/app/skills/ponytail/SKILL.md'))
process.exit(0)
