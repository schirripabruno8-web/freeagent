import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, WebContentsView, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AgentEvent } from '@contracts/agent'
import { IPC, type ProviderInfo } from '@contracts/ipc'
import { McpNewServerSchema, type McpListing, type McpProbeResult } from '@contracts/mcp'
import type { ApprovalRequest } from '@contracts/permissions'
import { PonytailModeSchema } from '@contracts/skills'
import { loadAgentsConfig } from './agents-config'
import { readAllowlist } from './allowlist'
import { CheckpointStore, pruneRuns } from './checkpoint'
import { electronPage } from './electron-page'
import { guardNavigation, hostAllowed, lockSession } from './guard'
import { chatUrlOf, HistoryStore, Recorder } from './history'
import { findBlender } from './mcp/detect'
import { McpPool } from './mcp/pool'
import { PidRegistry } from './mcp/process'
import { probeServer } from './mcp/probe'
import { parseSnippet } from './mcp/snippet'
import { addUserServers, describeServers, loadSources, removeUserServer, type Sources } from './mcp/sources'
import { loadModels } from './models'
import { Orchestrator } from './orchestrator'
import { makeAuthorizer } from './permissions'
import { loadSelectors } from './providers/load-selectors'
import { createSelectorAdapter } from './providers/selector-adapter'
import { createSandbox } from './sandbox'
import { Scheduler } from './scheduler'
import { loadSettings, ModeSchema, saveSettings } from './settings'
import { loadSkills, parsePonytailCommand, ponytailPrelude } from './skills'
import { allTools } from './tool-registry'
import { Usage } from './usage'

// Same profile as `npm run inspect` (that entry has no package.json next to it and would default to %APPDATA%\Electron): one login for both.
// FREEAGENT_DATA_DIR: lets scripts (mcp-live.mjs) run the app with empty settings, MCP servers and logins instead of the real ones.
app.setPath('userData', process.env['FREEAGENT_DATA_DIR'] ?? join(app.getPath('appData'), 'freeagent'))

const root = app.getAppPath()
/** loginHosts: where the provider's sign-in sends the page (an identity provider's own domains); allowed for navigation only. */
const providers: { id: string; label: string; url: string; loginHosts?: string[] }[] = JSON.parse(readFileSync(join(root, 'config/providers.json'), 'utf8'))
const selectorsFile = (id: string): string => join(root, 'config/selectors', `${id}.json`)
const providerUrl = (id: string): string => providers.find((p) => p.id === id)!.url

/** A provider can run only with valid selectors (captured with `npm run inspect`). */
function selectorsOf(id: string) {
  try {
    return loadSelectors(selectorsFile(id))
  } catch {
    return undefined
  }
}

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** Files the user picked in the native dialog: the only ones a task may attach (the renderer cannot name other paths). */
const pickedImages = new Set<string>()

const StartArgs = z.object({
  task: z.string().min(1).max(20_000),
  opts: z.object({ provider: z.string(), cwd: z.string().min(1), model: z.string().max(200).optional(), images: z.array(z.string()).max(MAX_IMAGES).optional(), resume: z.boolean().optional() })
})

const data = app.getPath('userData')
const settingsFile = join(data, 'settings.json')
const allowlistFile = join(data, 'bash-allowlist.json')
const checkpointsRoot = join(data, 'checkpoints')
// FREEAGENT_HISTORY_DIR: lets scripts/ui-shots.mjs show made-up chats without touching the real history.
const history = new HistoryStore(process.env['FREEAGENT_HISTORY_DIR'] ?? join(data, 'history'))
const agentsFile = join(root, 'config/agents.json')
// One checkpoint folder per app run; old runs are pruned at startup.
const store = new CheckpointStore(join(checkpointsRoot, new Date().toISOString().replace(/[:.]/g, '-')))
const usage = new Usage(join(data, 'usage.json'))
let settings = loadSettings(settingsFile)
/** Bundled skills first (the first of two with the same name wins), then the user's own in %APPDATA%/freeagent/skills. */
const skillSources = (): { dir: string; source: 'bundled' | 'user' }[] => [
  { dir: join(root, 'skills'), source: 'bundled' },
  { dir: join(data, 'skills'), source: 'user' }
]
const pending = new Map<string, (allow: boolean) => void>()

// Limits are read once, at startup: the scheduler must outlive a task to remember which provider is resting.
const toolNames = [...allTools.map((t) => t.name), 'look', 'delegate']
const providerIds = providers.map((p) => p.id)
const scheduler = new Scheduler(loadAgentsConfig(agentsFile, toolNames, providerIds).config.limits)

// MCP: one pool for the whole run (its processes must outlive a task's end only until that task's agents release them).
const mcpFile = join(root, 'config/mcp.json')
const mcpWork = join(data, 'mcp-work')
const mcpPids = new PidRegistry(join(data, 'mcp-pids.json'))
/** Agents whose last MCP result read like orders: their next change or command asks, even in auto/full. */
const taint = new Set<string>()
const mcpUserFile = join(data, 'mcp.user.json')
let pool: McpPool | undefined
let poolStamp = ''
let sources: Sources = { all: [], servers: new Map(), problems: [] }
let activeOrch: Orchestrator | undefined
let mcpProblems: string[] = []

function mcpWorkDir(server: string, agent: string): string {
  const d = join(mcpWork, server, agent)
  mkdirSync(d, { recursive: true })
  return d
}

const mtime = (f: string): number => {
  try {
    return statSync(f).mtimeMs
  } catch {
    return -1 // missing file = no servers from it
  }
}

/** (Re)reads config/mcp.json, the user's mcp.user.json and the switched-off list when any changed and nothing is running, so editing them needs no restart. */
async function refreshPool(): Promise<void> {
  const stamp = `${mtime(mcpFile)}|${mtime(mcpUserFile)}|${settings.mcpDisabled.join(',')}`
  if (pool && stamp === poolStamp) return
  if (pool && pool.status().some((s) => s.instances.length || s.holder)) return // never swap the pool under a running agent
  await pool?.shutdown()
  poolStamp = stamp
  sources = loadSources(mcpFile, mcpUserFile, settings.mcpDisabled)
  mcpProblems = sources.problems
  pool = new McpPool({
    servers: sources.servers,
    workDir: mcpWorkDir,
    registry: mcpPids,
    vars: mcpVars(),
    onNote: (agent, text) => activeOrch?.noteFor(agent, text)
  })
}

const mcpVars = (): Record<string, string> => ({ blenderExe: findBlender() ?? '' })

let win: BrowserWindow
/** The window the user logs into and watches, one per provider. The main agent runs in it. */
const views = new Map<string, WebContentsView>()
/** Extra windows for running sub-agents (same login, own chat), closed when the sub-agent ends. */
const sessionViews = new Map<string, WebContentsView>()
let current: WebContentsView | undefined
let task: AbortController | undefined

// EVERY provider view is attached and sized, the watched one on top. A view with no size (not attached = 0x0) draws no message list, and so does a view FULLY covered by another
// (Chromium treats it as occluded: measured with a DeepSeek chat, 0 messages covered vs 3 with a 2 px strip showing, and no animation frames): background views stick out 2 px to the left.
const layout = (): void => {
  const { width, height } = win.getContentBounds()
  const split = Math.round(width * 0.45)
  for (const v of [...views.values(), ...sessionViews.values()]) {
    v.setBounds(v === current ? { x: split, y: 0, width: width - split, height } : { x: split - 2, y: 0, width: width - split + 2, height })
  }
}

function newView(id: string, throttle: boolean): WebContentsView {
  const v = new WebContentsView({
    webPreferences: { partition: `persist:${id}`, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: throttle }
  })
  lockSession(v.webContents.session)
  guardNavigation(v.webContents, [...(selectorsOf(id)?.allowedHosts ?? [new URL(providerUrl(id)).hostname]), ...(providers.find((p) => p.id === id)?.loginHosts ?? [])])
  void v.webContents.loadURL(providerUrl(id))
  return v
}

function viewFor(id: string): WebContentsView {
  let v = views.get(id)
  if (!v) views.set(id, (v = newView(id, true)))
  return v
}

function showView(v: WebContentsView): void {
  win.contentView.addChildView(v) // a view that is already a child moves to the top
  current = v
  layout()
}

const show = (id: string): WebContentsView => (showView(viewFor(id)), viewFor(id))

/** Asks the user and waits. Resolves false if the task is stopped meanwhile. */
function requestApproval(req: Omit<ApprovalRequest, 'id'>, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const id = randomUUID()
    pending.set(id, resolve)
    signal.addEventListener('abort', () => pending.delete(id) && resolve(false), { once: true })
    win.webContents.send(IPC.approval, { ...req, id })
  })
}

// Only the app's own UI may call these; provider pages have their own webContents.
const fromUi = (e: IpcMainInvokeEvent): void => {
  if (e.sender !== win.webContents) throw new Error('forbidden sender')
}

const pageAdapter = (id: string, view: WebContentsView) =>
  createSelectorAdapter(electronPage(view), () => {
    const c = selectorsOf(id)
    if (!c) throw new Error(`no selectors for ${id}: run "npm run inspect -- ${id}" and send the files`)
    return c
  })

function registerIpc(): void {
  ipcMain.handle(IPC.listProviders, (e): ProviderInfo[] => {
    fromUi(e)
    return providers.map(({ id, label }) => {
      const c = selectorsOf(id)
      return { id, label, ready: !!c, modelPicker: !!c?.model }
    })
  })

  ipcMain.handle(IPC.listModels, (e) => (fromUi(e), loadModels(join(root, 'config/models.json')).models))

  ipcMain.handle(IPC.listPageModels, async (e, id: unknown) => {
    fromUi(e)
    if (typeof id !== 'string' || !providers.some((p) => p.id === id)) throw new Error('unknown provider')
    if (task) throw new Error('a task is running: its chat page must not be touched')
    if (!selectorsOf(id)?.model) throw new Error(`${id} has no model picker in its selectors`)
    return pageAdapter(id, show(id)).listModels()
  })

  ipcMain.handle(IPC.listSkills, (e) => (fromUi(e), loadSkills(skillSources()).skills.map(({ name, description, source }) => ({ name, description, source }))))

  ipcMain.handle(IPC.getPonytail, (e) => (fromUi(e), settings.ponytail))

  ipcMain.handle(IPC.setPonytail, (e, m: unknown) => {
    fromUi(e)
    settings = { ...settings, ponytail: PonytailModeSchema.parse(m) }
    saveSettings(settingsFile, settings)
  })

  ipcMain.handle(IPC.getUsage, (e) => (fromUi(e), usage.summary()))

  ipcMain.handle(IPC.pickFolder, async (e, start: unknown) => {
    fromUi(e)
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: typeof start === 'string' && start.trim() ? start : undefined
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.pickImages, async (e) => {
    fromUi(e)
    // Test hook for scripts/live-run.mjs: a native dialog cannot be driven from outside, so this variable ("path|path") stands in for the user's pick.
    const forced = process.env['FREEAGENT_TEST_IMAGES']
    const r = forced
      ? { canceled: false, filePaths: forced.split('|') }
      : await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Immagini', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
        })
    const ok = r.canceled ? [] : r.filePaths.filter((f) => statSync(f).size <= MAX_IMAGE_BYTES).slice(0, MAX_IMAGES)
    pickedImages.clear()
    for (const f of ok) pickedImages.add(f)
    return ok
  })

  ipcMain.handle(IPC.showProvider, (e, id: unknown) => {
    fromUi(e)
    if (typeof id !== 'string' || !providers.some((p) => p.id === id)) throw new Error('unknown provider')
    show(id)
  })

  ipcMain.handle(IPC.showSession, (e, agentId: unknown) => {
    fromUi(e)
    const v = typeof agentId === 'string' ? sessionViews.get(agentId) : undefined
    if (v) showView(v) // gone already = the sub-agent finished: nothing to watch
  })

  ipcMain.handle(IPC.listMcp, async (e): Promise<McpListing> => {
    fromUi(e)
    await refreshPool()
    return { servers: describeServers(sources.all, pool?.status() ?? []), problems: sources.problems, userFile: mcpUserFile }
  })

  ipcMain.handle(IPC.restartMcp, async (e, name: unknown) => {
    fromUi(e)
    if (typeof name !== 'string') throw new Error('bad arguments')
    await pool?.restart(name)
  })

  ipcMain.handle(IPC.openMcpConfig, async (e) => {
    fromUi(e)
    const err = await shell.openPath(mcpFile)
    if (err) throw new Error(err)
  })

  ipcMain.handle(IPC.openMcpUserFile, async (e) => {
    fromUi(e)
    if (!existsSync(mcpUserFile)) {
      mkdirSync(data, { recursive: true })
      writeFileSync(mcpUserFile, JSON.stringify({ mcpServers: {} }, null, 2))
    }
    const err = await shell.openPath(mcpUserFile)
    if (err) throw new Error(err)
  })

  // Reading what was pasted starts nothing and saves nothing.
  ipcMain.handle(IPC.parseMcp, (e, text: unknown) => {
    fromUi(e)
    if (typeof text !== 'string' || text.length > 100_000) throw new Error('bad arguments')
    return parseSnippet(text)
  })

  // Changing the servers under a running task would swap what its agents see: not while one runs.
  const noTask = (): void => {
    if (task) throw new Error('a task is running: change the MCP servers when it ends')
  }

  ipcMain.handle(IPC.addMcp, async (e, servers: unknown) => {
    fromUi(e)
    noTask()
    const list = z.array(McpNewServerSchema).min(1).max(20).parse(servers)
    await refreshPool()
    const added = addUserServers(mcpUserFile, list, sources.all.map((s) => s.name))
    await refreshPool()
    return added
  })

  ipcMain.handle(IPC.setMcpEnabled, async (e, name: unknown, enabled: unknown) => {
    fromUi(e)
    noTask()
    if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new Error('bad arguments')
    if (!sources.all.some((s) => s.name === name)) throw new Error(`no server named "${name}"`)
    const off = new Set(settings.mcpDisabled)
    if (enabled) off.delete(name)
    else off.add(name)
    settings = { ...settings, mcpDisabled: [...off] }
    saveSettings(settingsFile, settings)
    await refreshPool()
  })

  ipcMain.handle(IPC.removeMcp, async (e, name: unknown) => {
    fromUi(e)
    noTask()
    if (typeof name !== 'string') throw new Error('bad arguments')
    if (sources.all.find((s) => s.name === name)?.source === 'bundled') throw new Error('an included server cannot be removed: switch it off instead')
    if (!removeUserServer(mcpUserFile, name)) throw new Error(`no server named "${name}" in ${mcpUserFile}`)
    settings = { ...settings, mcpDisabled: settings.mcpDisabled.filter((n) => n !== name) }
    saveSettings(settingsFile, settings)
    await refreshPool()
  })

  ipcMain.handle(IPC.testMcp, async (e, name: unknown): Promise<McpProbeResult> => {
    fromUi(e)
    noTask()
    if (typeof name !== 'string') throw new Error('bad arguments')
    const s = sources.all.find((x) => x.name === name)
    if (!s) throw new Error(`no server named "${name}"`)
    return probeServer(name, s.config, { workDir: mcpWorkDir, registry: mcpPids, vars: mcpVars() })
  })

  ipcMain.handle(IPC.startTask, async (e, taskText: unknown, opts: unknown) => {
    fromUi(e)
    const a = StartArgs.parse({ task: taskText, opts })
    if (task) throw new Error('a task is already running')
    const rec = new Recorder()
    const startedAt = Date.now()
    const emit = (ev: AgentEvent): void => {
      rec.push(ev)
      win.webContents.send(IPC.event, ev)
    }
    // `/ponytail ultra`, `stop ponytail`...: sets the level; what follows (if anything) is the real task.
    const cmd = parsePonytailCommand(a.task)
    let goal = a.task
    if (cmd) {
      settings = { ...settings, ponytail: cmd.mode }
      saveSettings(settingsFile, settings)
      emit({ type: 'status', text: `ponytail: ${cmd.mode}` })
      if (!cmd.rest) {
        emit({ type: 'finished', report: { reason: 'finish', summary: `Ponytail: ${cmd.mode}`, steps: 0 } })
        return
      }
      goal = cmd.rest
    }
    if (!providers.some((p) => p.id === a.opts.provider)) throw new Error('unknown provider')
    if (!selectorsOf(a.opts.provider)) {
      throw new Error(`no selectors for ${a.opts.provider} yet: run "npm run inspect -- ${a.opts.provider}" (log in, send two messages) and send the files`)
    }
    if (!statSync(a.opts.cwd).isDirectory()) throw new Error('cwd is not a directory')
    const images = a.opts.images ?? []
    for (const f of images) {
      if (!pickedImages.has(f) || !statSync(f).isFile()) throw new Error('image was not chosen with the image picker (or is gone)')
    }
    if (images.length && !selectorsOf(a.opts.provider)?.attach) {
      throw new Error(`${a.opts.provider} has no attach selectors yet: it cannot receive images (capture it with npm run inspect)`)
    }
    const sandbox = createSandbox(a.opts.cwd)
    const cwd = sandbox.resolve('.', false) // the real workspace root: tools label paths relative to it
    const view = show(a.opts.provider)
    const ac = (task = new AbortController())
    emit({ type: 'user', text: goal, ...(a.opts.resume ? { resume: true } : {}), ...(images.length ? { images: images.length } : {}) })

    // Skills and sub-agents are re-read at every task, so editing config/agents.json needs no restart.
    const { skills, problems: skillProblems } = loadSkills(skillSources())
    for (const p of skillProblems) emit({ type: 'status', text: `skills: ${p}` })
    await refreshPool()
    for (const p of mcpProblems) emit({ type: 'status', text: `mcp: ${p}` })
    const { config, problems } = loadAgentsConfig(agentsFile, toolNames, providerIds, skills.map((s) => s.name), pool?.serverNames() ?? [])
    for (const p of problems) emit({ type: 'status', text: `config/agents.json: ${p}` })

    const orchestrator = new Orchestrator({
      config,
      scheduler,
      isReady: (p) => !!selectorsOf(p),
      hasAttach: (p) => !!selectorsOf(p)?.attach,
      makeSession: (provider, agentId) => {
        const v = newView(provider, false) // background tabs must not be throttled: the chat has to keep streaming
        sessionViews.set(agentId, v)
        // Above the UI page (it fills the whole window: a view under it is fully covered, gets no frames and renders nothing) but under the watched view.
        win.contentView.addChildView(v)
        if (current) win.contentView.addChildView(current)
        layout()
        return {
          adapter: pageAdapter(provider, v),
          dispose: () => {
            sessionViews.delete(agentId)
            if (!v.webContents.isDestroyed()) win.contentView.removeChildView(v)
            if (current === v) showView(viewFor(a.opts.provider)) // the watched window is closing: go back to the main one
            if (!v.webContents.isDestroyed()) v.webContents.close()
          }
        }
      },
      tools: allTools,
      skills,
      prelude: () => ponytailPrelude(skills, settings.ponytail),
      sandbox,
      cwd,
      checkpoint: (tool, files) => store.create(tool, files),
      authorize: (name, key = name) =>
        makeAuthorizer({
          cwd,
          sandbox,
          getMode: () => settings.mode,
          allowlist: () => readAllowlist(allowlistFile),
          requestApproval: (r) => requestApproval(name === 'main' ? r : { ...r, agent: name }, ac.signal),
          forceAsk: () => taint.has(key),
          onAsked: () => void taint.delete(key)
        }),
      emit,
      mcp: pool,
      mcpWorkDir,
      taint,
      onSend: (p) => usage.record(p)
    })
    activeOrch = orchestrator
    void orchestrator
      .runMain({ provider: a.opts.provider, model: a.opts.model, task: goal, images, resume: a.opts.resume, adapter: pageAdapter(a.opts.provider, view), signal: ac.signal })
      .then((report) => {
        try {
          history.record({
            provider: a.opts.provider,
            model: a.opts.model,
            cwd,
            task: goal,
            chatUrl: view.webContents.isDestroyed() ? undefined : chatUrlOf(view.webContents.getURL(), providerUrl(a.opts.provider)),
            status: report.reason === 'finish' ? 'done' : report.reason === 'aborted' ? 'stopped' : 'error',
            summary: report.summary,
            startedAt,
            events: rec.events
          })
        } catch (err) {
          emit({ type: 'status', text: `cronologia non salvata: ${String(err)}` }) // never fails the task
        }
      })
      .finally(() => {
        task = undefined
        activeOrch = undefined
        taint.clear()
        for (const resolve of pending.values()) resolve(false)
        pending.clear()
      })
  })

  ipcMain.handle(IPC.listHistory, (e) => (fromUi(e), history.list()))
  ipcMain.handle(IPC.loadHistory, (e, id: unknown) => {
    fromUi(e)
    return typeof id === 'string' ? (history.load(id) ?? null) : null
  })
  ipcMain.handle(IPC.deleteHistory, (e, id: unknown) => {
    fromUi(e)
    if (typeof id === 'string') history.remove(id)
  })
  // Shows the provider's own page of that chat, so "Continua" goes on in the very same chat.
  ipcMain.handle(IPC.openHistory, async (e, id: unknown) => {
    fromUi(e)
    if (task) throw new Error('a task is running: stop it first')
    const entry = typeof id === 'string' ? history.load(id) : undefined
    if (!entry) throw new Error('chat not found')
    const m = entry.meta
    if (!providers.some((p) => p.id === m.provider)) throw new Error('unknown provider')
    const view = show(m.provider)
    const allowed = selectorsOf(m.provider)?.allowedHosts ?? [new URL(providerUrl(m.provider)).hostname]
    if (m.chatUrl && hostAllowed(m.chatUrl, allowed)) {
      try {
        await view.webContents.loadURL(m.chatUrl)
      } catch (err) {
        if ((err as { code?: string }).code !== 'ERR_ABORTED') throw err // redirects abort the first load
      }
    }
    return m
  })

  ipcMain.handle(IPC.stopTask, (e) => (fromUi(e), task?.abort()))

  ipcMain.handle(IPC.getMode, (e) => (fromUi(e), settings.mode))

  ipcMain.handle(IPC.setMode, (e, m: unknown) => {
    fromUi(e)
    settings = { ...settings, mode: ModeSchema.parse(m) }
    saveSettings(settingsFile, settings)
  })

  ipcMain.handle(IPC.answerApproval, (e, id: unknown, allow: unknown) => {
    fromUi(e)
    if (typeof id !== 'string' || typeof allow !== 'boolean') throw new Error('bad arguments')
    const resolve = pending.get(id)
    pending.delete(id)
    resolve?.(allow)
  })

  ipcMain.handle(IPC.listCheckpoints, (e) => (fromUi(e), store.list()))

  ipcMain.handle(IPC.restoreCheckpoint, (e, id: unknown) => {
    fromUi(e)
    if (task) throw new Error('stop the task before restoring a checkpoint')
    if (typeof id !== 'string' || !/^\d{6}$/.test(id)) throw new Error('bad checkpoint id')
    return store.restoreTo(id)
  })
}

void app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  lockSession(win.webContents.session)
  win.on('resize', layout)
  mkdirSync(data, { recursive: true })
  if (!existsSync(allowlistFile)) writeFileSync(allowlistFile, '[]\n') // the user's own list of bash commands that skip the question
  void pruneRuns(checkpointsRoot, 7 * 24 * 3600 * 1000)
  mcpPids.cleanupOrphans() // a Blender left behind by a crash would keep eating RAM
  registerIpc()
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) void win.loadURL(dev)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  // The UI occupies the left 45%; the provider view the rest (see layout()).
})

app.on('window-all-closed', () => app.quit())

// Leave no MCP process running: stop them all first, then really quit.
let quitting = false
app.on('before-quit', (e) => {
  if (quitting || !pool) return
  e.preventDefault()
  quitting = true
  void pool.shutdown().finally(() => app.quit())
})
