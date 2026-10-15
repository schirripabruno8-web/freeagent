// Stand-in for "Blender": ONE process with GLOBAL state (the active object, like bpy.context) that serves ONE client connection at a time.
// Usage: node fake-blender-backend.mjs <port|0>   -> prints "READY <port>" when listening.
import net from 'node:net'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const objects = new Map() // name -> { scale }
let active = null // the single global "active object"
let client = null // the one connection allowed

const commands = {
  async create({ name }) {
    objects.set(name, { scale: 1 })
    return `created ${name}`
  },
  async select({ name }) {
    if (!objects.has(name)) throw new Error(`no object ${name}`)
    active = name
    return `active=${name}`
  },
  // Like a Blender operator: it acts on whatever is active WHEN IT RUNS, and takes a moment.
  async scale_active({ factor }) {
    await sleep(20)
    if (!active) throw new Error('no active object')
    objects.get(active).scale *= factor
    return `scaled ${active} by ${factor}`
  },
  async get({ name }) {
    return JSON.stringify({ name, ...objects.get(name), active })
  }
}

const server = net.createServer((sock) => {
  if (client) {
    sock.end(JSON.stringify({ id: 0, error: 'busy: another client is connected' }) + '\n')
    return
  }
  client = sock
  let buf = ''
  sock.on('data', async (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      const { id, cmd, args } = JSON.parse(line)
      try {
        const result = await commands[cmd](args ?? {})
        sock.write(JSON.stringify({ id, result }) + '\n')
      } catch (e) {
        sock.write(JSON.stringify({ id, error: String(e.message ?? e) }) + '\n')
      }
    }
  })
  sock.on('close', () => (client = null))
  sock.on('error', () => (client = null))
})
server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => console.log(`READY ${server.address().port}`))
