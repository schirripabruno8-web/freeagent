import { useEffect, useRef, useState } from 'react'
import type { HistoryMeta } from '@contracts/history'
import type { ProviderInfo } from '@contracts/ipc'
import type { UsageInfo } from '@contracts/models'
import type { PermissionMode } from '@contracts/permissions'
import { applyEvent, type LogItem } from './log'
import { reduceAgents, type AgentRow } from './agents-state'
import { AgentsPanel } from './AgentsPanel'
import { Approvals } from './Approvals'
import { Checkpoints } from './Checkpoints'
import { HistoryPanel } from './HistoryPanel'
import { Icon, Logo } from './Icons'
import { LogView } from './LogView'
import { McpPanel } from './McpPanel'
import { ModelPicker } from './ModelPicker'
import { SkillsPanel } from './SkillsPanel'

const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'readonly', label: 'Sola lettura', hint: "L'agente non scrive file e non esegue comandi." },
  { id: 'ask', label: 'Chiedi prima', hint: 'Ogni modifica di file e ogni comando shell aspetta il tuo ok.' },
  { id: 'auto', label: 'Auto in cartella', hint: 'Le modifiche dentro la cartella passano da sole; i comandi shell chiedono sempre.' },
  { id: 'full', label: 'Auto completa', hint: 'Modifiche e comandi shell passano da soli; fuori dalla cartella chiede ancora. I comandi shell non hanno checkpoint.' }
]

const RECENT_KEY = 'freeagent.recentCwd'
const RECENT_MAX = 10
type Tab = 'task' | 'history' | 'tools'

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function loadRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return [] // storage can be unavailable: the list is a convenience, not state
  }
}

export default function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [provider, setProvider] = useState('')
  const [mode, setMode] = useState<PermissionMode>('ask')
  const [recent, setRecent] = useState<string[]>(loadRecent)
  const [cwd, setCwd] = useState(() => loadRecent()[0] ?? '')
  const [task, setTask] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [log, setLog] = useState<LogItem[]>([])
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [running, setRunning] = useState(false)
  const [model, setModel] = useState('default')
  const [usage, setUsage] = useState<Record<string, UsageInfo>>({})
  const [tab, setTab] = useState<Tab>('task')
  const [viewing, setViewing] = useState<HistoryMeta | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [historyCount, setHistoryCount] = useState(0)
  const [optionsOpen, setOptionsOpen] = useState(true)
  const logRef = useRef<HTMLDivElement>(null)

  const fail = (kind: string) => (err: unknown) => setLog((l) => applyEvent(l, { type: 'error', kind, message: String(err) }))
  const refreshUsage = () => window.api.getUsage().then(setUsage, fail('usage'))

  useEffect(() => {
    window.api.listProviders().then((list) => {
      setProviders(list)
      setProvider(list[0]?.id ?? '')
    })
    window.api.getMode().then(setMode, fail('mode'))
    refreshUsage()
    window.api.listHistory().then((l) => setHistoryCount(l.length), () => undefined)
  }, [])

  const changeMode = (m: PermissionMode) => {
    setMode(m)
    window.api.setMode(m).catch(fail('mode'))
  }

  useEffect(
    () =>
      window.api.onEvent((e) => {
        setLog((l) => applyEvent(l, e))
        setAgents((a) => reduceAgents(a, e))
        // Sub-agents never send 'finished': only the main agent ends the task.
        if (e.type === 'finished' && !e.agent) {
          setRunning(false)
          setTimeout(() => setHistoryVersion((v) => v + 1), 900) // main saves the chat right after the last event
        }
        if (e.type === 'finished' || e.type === 'tool_result') refreshUsage()
      }),
    []
  )

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log, tab])

  // Runs on startup (once the list sets the default) and on every select change.
  useEffect(() => {
    if (!provider) return
    window.api.showProvider(provider).catch(fail('show'))
  }, [provider])

  const current = providers.find((p) => p.id === provider)
  const u = usage[provider] ?? { today: 0, week: 0 }
  const canRun = !running && !!provider && !!cwd.trim() && !!task.trim() && current?.ready !== false
  const followUp = !!viewing || log.length > 0 // there is a conversation on screen: the natural next step is to go on in it
  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[1]!

  const start = (resume = false) => {
    if (!resume) {
      setLog([])
      setViewing(null)
    }
    setAgents([])
    setRunning(true)
    setOptionsOpen(false)
    setTab('task')
    window.api
      .startTask(task, { provider, cwd, ...(model === 'default' ? {} : { model }), ...(images.length ? { images } : {}), ...(resume ? { resume } : {}) })
      .then(() => {
        setTask('')
        setImages([])
        // Remember only folders the app accepted.
        const dir = cwd.trim()
        const next = [dir, ...recent.filter((r) => r !== dir)].slice(0, RECENT_MAX)
        setRecent(next)
        try {
          localStorage.setItem(RECENT_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
      })
      .catch((err: unknown) => {
        setRunning(false)
        fail('start')(err)
      })
  }

  const openChat = async (m: HistoryMeta) => {
    try {
      const entry = await window.api.loadHistory(m.id)
      if (!entry) throw new Error('chat non trovata')
      setLog(entry.events.reduce<LogItem[]>(applyEvent, []))
      setAgents([])
      setProvider(m.provider)
      setCwd(m.cwd)
      setModel(m.model ?? 'default')
      setTask('')
      setImages([])
      setViewing(m)
      setOptionsOpen(false)
      setTab('task')
      await window.api.openHistory(m.id) // shows the provider's page of this chat
    } catch (err) {
      fail('history')(err)
    }
  }

  const newChat = () => {
    setLog([])
    setAgents([])
    setViewing(null)
    setOptionsOpen(true)
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo />
          <span>FreeAgent</span>
        </div>
        <div className={`pill ${running ? 'busy' : current?.ready === false ? 'warn' : 'ok'}`} title={`Messaggi inviati: oggi ${u.today} · 7 giorni ${u.week}`}>
          <span className="dot" />
          {running ? 'In esecuzione' : current?.ready === false ? 'Non pronto' : 'Pronto'}
          <span className="muted">
            {current ? ` · ${current.label}` : ''} · oggi {u.today}
          </span>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {(
          [
            ['task', 'Task', 'chat'],
            ['history', 'Recenti', 'clock'],
            ['tools', 'Strumenti', 'layers']
          ] as const
        ).map(([id, label, icon]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <Icon name={icon} size={15} />
            {label}
            {id === 'history' && historyCount > 0 && <span className="count">{historyCount}</span>}
          </button>
        ))}
      </nav>

      {tab === 'task' && (
        <div className="pane">
          <div className="timeline" ref={logRef}>
            {viewing && (
              <div className="banner">
                <Icon name="clock" size={15} />
                <div>
                  <strong>{viewing.title}</strong>
                  <div className="muted small">
                    Chat salvata · {viewing.provider} · {base(viewing.cwd)} — scrivi sotto una correzione e premi Continua: prosegue nella stessa chat.
                  </div>
                </div>
                <button type="button" className="ghost sm" onClick={newChat} disabled={running}>
                  Chiudi
                </button>
              </div>
            )}
            {log.length === 0 && !viewing ? <Empty ready={current?.ready !== false} label={current?.label ?? ''} /> : <LogView items={log} />}
          </div>

          <AgentsPanel rows={agents} />

          <section className="composer">
            {optionsOpen ? (
              <div className="options">
                <div className="grid2">
                  <label className="field">
                    <span>Provider</span>
                    <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label + (p.ready === false ? ' (non pronto)' : '')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ModelPicker provider={current} value={model} onChange={setModel} />
                </div>
                <div className="field">
                  <span>Permessi</span>
                  <div className="seg" role="radiogroup" aria-label="Permessi">
                    {MODES.map((m) => (
                      <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? `on ${m.id}` : ''} onClick={() => changeMode(m.id)}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <small className="hint">{modeInfo.hint}</small>
                </div>
                <div className="field">
                  <span>Cartella di lavoro</span>
                  <div className="cwd">
                    <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\percorso\della\cartella" />
                    <button
                      type="button"
                      className="icon"
                      title="Sfoglia…"
                      onClick={() => window.api.pickFolder(cwd).then((dir) => dir && setCwd(dir), fail('pick'))}
                    >
                      <Icon name="folder" />
                    </button>
                    <select value="" disabled={!recent.length} title="Cartelle usate di recente" onChange={(e) => e.target.value && setCwd(e.target.value)}>
                      <option value="">Recenti</option>
                      {recent.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <button type="button" className="summary" onClick={() => setOptionsOpen(true)} title="Cambia provider, modello, permessi o cartella">
                <Icon name="sliders" size={15} />
                <span className="chip">{current?.label ?? provider}</span>
                <span className="chip">{model === 'default' ? 'modello della pagina' : model}</span>
                <span className="chip">{modeInfo.label}</span>
                <span className="chip mono">{base(cwd) || '—'}</span>
                <span className="edit">Modifica</span>
              </button>
            )}

            {current?.ready === false && (
              <div className="notice error">
                <Icon name="x" size={14} />
                <span>
                  Mancano i selettori di {current.label}: esegui <code>npm run inspect -- {current.id}</code> e invia i file a Claude.
                </span>
              </div>
            )}

            <textarea
              rows={3}
              placeholder={followUp ? 'Scrivi una correzione o una richiesta in più…' : 'Descrivi cosa deve fare l’agente…'}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.ctrlKey && e.key === 'Enter' && canRun) start(followUp)
              }}
            />
            {images.length > 0 && (
              <div className="attachments">
                {images.map((f) => (
                  <span key={f} className="chip file" title={f}>
                    <Icon name="image" size={12} />
                    {f.split(/[\\/]/).pop()}
                    <button type="button" className="ghost icon" aria-label="Togli" onClick={() => setImages(images.filter((x) => x !== f))}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="actions">
              <button
                type="button"
                className="ghost"
                title="Immagini inviate col primo messaggio dell’agente principale (solo provider con i selettori di allegato)"
                onClick={() => window.api.pickImages().then(setImages, fail('pick'))}
              >
                <Icon name="image" /> Immagine
              </button>
              <span className="grow hint">Ctrl+Invio</span>
              <button type="button" className="danger" onClick={() => window.api.stopTask()} disabled={!running}>
                <Icon name="stop" size={14} /> Ferma
              </button>
              <button
                type="button"
                className={followUp ? 'primary' : ''}
                onClick={() => start(true)}
                disabled={!canRun}
                title="Prosegue nella STESSA chat che vedi a destra (Avvia ne apre una nuova)"
              >
                <Icon name="redo" /> Continua
              </button>
              <button type="button" className={followUp ? '' : 'primary'} onClick={() => start()} disabled={!canRun} title="Apre una chat nuova sul provider">
                <Icon name="play" size={14} /> Avvia
              </button>
            </div>
          </section>
        </div>
      )}

      {tab === 'history' && (
        <div className="pane scroll">
          <HistoryPanel version={historyVersion} running={running} activeId={viewing?.id} onOpen={openChat} onCount={setHistoryCount} onError={(m) => fail('history')(m)} />
        </div>
      )}

      {tab === 'tools' && (
        <div className="pane scroll tools">
          <McpPanel busy={running} onError={(message) => fail('mcp')(message)} />
          <SkillsPanel onError={(message) => fail('skills')(message)} />
          <Checkpoints disabled={running} />
        </div>
      )}

      <Approvals />
    </div>
  )
}

function Empty({ ready, label }: { ready: boolean; label: string }) {
  return (
    <div className="empty hero">
      <Logo size={40} />
      <strong>Cosa vuoi fare?</strong>
      <ol>
        <li>{ready ? <>Accedi a {label || 'un provider'} nel browser a destra (una volta sola).</> : <>Per {label} mancano i selettori: vedi l’avviso qui sotto.</>}</li>
        <li>Scegli la cartella di lavoro e descrivi il compito.</li>
        <li>
          <b>Avvia</b> apre una chat nuova, <b>Continua</b> prosegue in quella aperta.
        </li>
      </ol>
      <span className="hint">Le chat passate sono nella scheda Recenti.</span>
    </div>
  )
}
