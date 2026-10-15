import { useEffect, useState } from 'react'
import type { McpCandidate, McpListing, McpProbeResult, McpServerStatus } from '@contracts/mcp'

const MODE: Record<McpServerStatus['mode'], string> = {
  shared: 'condiviso',
  serialized: 'una chiamata alla volta',
  lease: 'un agente alla volta',
  'instance-per-agent': 'un processo per agente'
}

const STATE = { starting: 'in avvio', ready: 'pronto', closing: 'in chiusura' } as const

/** A candidate read from what the user pasted, plus the choices made before it is added. */
interface Row extends McpCandidate {
  picked: boolean
  description: string
  mainAccess: boolean
  concurrency: 'lease' | 'shared'
}

/** The reason of an error that crossed the IPC boundary, without Electron's "Error invoking remote method" wrapper. */
const why = (e: unknown): string => String(e).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, '').replace(/^Error: /, '')

const where = (c: McpCandidate['config']): string => (c.type === 'http' ? (c.url ?? '') : [c.command, ...(c.args ?? [])].join(' '))

export function McpPanel({ busy, onError }: { busy: boolean; onError(message: string): void }) {
  const [listing, setListing] = useState<McpListing>({ servers: [], problems: [], userFile: '' })
  const [open, setOpen] = useState(false)
  const [tests, setTests] = useState<Record<string, 'running' | McpProbeResult>>({})
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [readError, setReadError] = useState<string>()
  const [addError, setAddError] = useState<string>()

  const servers = listing.servers
  const refresh = () => window.api.listMcp().then(setListing, (e: unknown) => onError(String(e)))

  useEffect(() => {
    void refresh()
    if (!open) return
    const t = setInterval(() => void refresh(), 2000) // only while the panel is open
    return () => clearInterval(t)
  }, [open])

  // Reading a paste starts nothing and saves nothing, so it follows the typing.
  useEffect(() => {
    if (!text.trim()) {
      setRows([])
      setReadError(undefined)
      return
    }
    const t = setTimeout(
      () =>
        window.api.parseMcp(text).then(
          (r) => {
            setRows(r.candidates.map((c) => ({ ...c, picked: true, description: '', mainAccess: true, concurrency: 'lease' })))
            setReadError(r.error)
          },
          (e: unknown) => setReadError(why(e))
        ),
      300
    )
    return () => clearTimeout(t)
  }, [text])

  const act = (p: Promise<unknown>) => p.then(refresh, (e: unknown) => onError(why(e)))
  const restart = (name: string) => act(window.api.restartMcp(name))
  const toggle = (s: McpServerStatus) => act(window.api.setMcpEnabled(s.name, !s.enabled))
  const remove = (s: McpServerStatus) => {
    if (window.confirm(`Rimuovere il server "${s.name}"? Si cancella dal tuo file, il programma resta dov'è.`)) void act(window.api.removeMcp(s.name))
  }
  const test = (name: string) => {
    setTests((t) => ({ ...t, [name]: 'running' }))
    window.api.testMcp(name).then(
      (r) => setTests((t) => ({ ...t, [name]: r })),
      (e: unknown) => setTests((t) => ({ ...t, [name]: { ok: false, error: why(e) } }))
    )
  }

  const set = (i: number, patch: Partial<Row>) => setRows((all) => all.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const picked = rows.filter((r) => r.picked)
  const add = () => {
    setAddError(undefined)
    window.api
      .addMcp(
        picked.map((r) => ({
          name: r.name.trim(),
          config: r.config,
          ...(r.description.trim() ? { description: r.description.trim() } : {}),
          mainAccess: r.mainAccess,
          concurrency: r.concurrency
        }))
      )
      .then(
        () => {
          setText('')
          setAdding(false)
          return refresh()
        },
        (e: unknown) => setAddError(why(e))
      )
  }

  const on = servers.filter((s) => s.enabled).length
  const running = servers.reduce((n, s) => n + s.instances.length, 0)

  return (
    <details className="mcp" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        MCP ({on}/{servers.length} attivi){running ? ` · ${running} in esecuzione` : ''}
      </summary>
      {servers.length === 0 && <div className="hint">Nessun server MCP: aggiungine uno qui sotto.</div>}
      <ul>
        {servers.map((s) => {
          const t = tests[s.name]
          return (
            <li key={s.name} className={s.enabled ? '' : 'off'}>
              <div className="mcp-head">
                <label className="switch" title={busy ? 'Non durante un task' : s.enabled ? 'Spegni: gli agenti non lo vedono più' : 'Accendi'}>
                  <input type="checkbox" checked={s.enabled} disabled={busy} onChange={() => void toggle(s)} />
                  <span />
                </label>
                <strong>{s.name}</strong>
                <span className="badge">{s.source === 'bundled' ? 'incluso' : 'tuo'}</span>
                {s.remote && (
                  <span className="badge fair" title="Quello che gli mandi esce dal PC">
                    in rete
                  </span>
                )}
                {s.enabled && <span className="badge">{MODE[s.mode]}</span>}
                {s.queued > 0 && <span className="badge fair">{s.queued} in coda</span>}
                {s.holder && <span className="muted">usato da {s.holder}</span>}
              </div>
              {s.description && <div className="hint">{s.description}</div>}
              <code className="mcp-cmd">{s.summary}</code>
              {s.instances.map((i) => (
                <div key={i.agent} className="muted">
                  {i.agent}: {STATE[i.state]}
                  {i.pid ? ` (pid ${i.pid})` : ''}
                </div>
              ))}
              {s.tools && s.enabled && (
                <div className="hint">
                  Tool: {s.tools.slice(0, 8).join(', ')}
                  {s.tools.length > 8 ? ` +${s.tools.length - 8}` : ''}
                </div>
              )}
              {t === 'running' && <div className="hint">Prova in corso… (la prima volta può scaricare il pacchetto: fino a un minuto)</div>}
              {t && t !== 'running' && (
                <div className={`mcp-test ${t.ok ? 'good' : 'bad'}`}>
                  {t.ok ? `Funziona: ${t.tools.length} tool${t.tools.length ? ` (${t.tools.slice(0, 6).join(', ')}${t.tools.length > 6 ? '…' : ''})` : ''}` : t.error}
                </div>
              )}
              <div className="row-actions">
                <button type="button" className="ghost sm" disabled={busy || t === 'running'} onClick={() => test(s.name)} title="Lo avvia da solo, ne legge i tool e lo spegne">
                  Prova
                </button>
                <button type="button" className="ghost sm" disabled={!s.instances.length && !s.holder} onClick={() => void restart(s.name)} title="Chiude le istanze: la prossima chiamata ne avvia una nuova">
                  Riavvia
                </button>
                {s.source === 'user' && (
                  <button type="button" className="ghost sm danger" disabled={busy} onClick={() => remove(s)}>
                    Rimuovi
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {listing.problems.length > 0 && (
        <div className="mcp-problems">
          {listing.problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="mcp-add">
          <label>
            <span>
              Incolla qui la configurazione del server (JSON di Claude Desktop / Cursor / VS Code, un comando come <code>npx -y …</code>, <code>claude mcp add …</code> o un indirizzo)
            </span>
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{ "mcpServers": { "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] } } }'} spellCheck={false} autoFocus />
          </label>
          {readError && <div className="mcp-test bad">{readError}</div>}
          {rows.map((r, i) => (
            <div key={i} className="mcp-cand">
              <label className="check">
                <input type="checkbox" checked={r.picked} onChange={(e) => set(i, { picked: e.target.checked })} />
                Aggiungi
              </label>
              <input value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Nome del server" title="Il nome che gli agenti scrivono: minuscole, cifre, - e _" />
              <code className="mcp-cmd">{where(r.config)}</code>
              {r.config.type === 'http' && !r.config.url?.startsWith('http://127.0.0.1') && !r.config.url?.startsWith('http://localhost') && <div className="hint fair">È un server in rete: quello che gli mandano gli agenti esce dal tuo PC.</div>}
              {r.config.env && Object.keys(r.config.env).length > 0 && <div className="hint fair">Variabili: {Object.keys(r.config.env).join(', ')}. Restano scritte in chiaro nel file dei tuoi server.</div>}
              {r.notes?.map((n) => (
                <div key={n} className="hint fair">
                  {n}
                </div>
              ))}
              <input value={r.description} maxLength={300} placeholder="A cosa serve (opzionale: gli agenti lo leggono)" onChange={(e) => set(i, { description: e.target.value })} />
              <div className="mcp-opts">
                <label className="check">
                  <input type="checkbox" checked={r.mainAccess} onChange={(e) => set(i, { mainAccess: e.target.checked })} />
                  Lo usa anche l'agente principale
                </label>
                <select value={r.concurrency} onChange={(e) => set(i, { concurrency: e.target.value as Row['concurrency'] })} aria-label="Concorrenza">
                  <option value="lease">Un agente alla volta (consigliato)</option>
                  <option value="shared">Condiviso (solo se non tiene stato)</option>
                </select>
              </div>
            </div>
          ))}
          <div className="hint fair">Un server MCP è un programma che gira sul tuo PC con i tuoi permessi: aggiungi solo quelli di cui ti fidi. I sotto-agenti lo vedono solo se è elencato in "mcp" di config/agents.json.</div>
          {addError && <div className="mcp-test bad">{addError}</div>}
          <div className="row-actions">
            <button type="button" className="primary sm" disabled={busy || !picked.length || picked.some((r) => !r.name.trim())} onClick={add}>
              Aggiungi {picked.length > 1 ? `${picked.length} server` : 'server'}
            </button>
            <button
              type="button"
              className="ghost sm"
              onClick={() => {
                setAdding(false)
                setText('')
                setAddError(undefined)
              }}
            >
              Annulla
            </button>
          </div>
        </div>
      ) : (
        <div className="row-actions">
          <button type="button" className="primary sm" disabled={busy} onClick={() => setAdding(true)} title={busy ? 'Non durante un task' : undefined}>
            + Aggiungi server
          </button>
          <button type="button" className="ghost sm" onClick={() => window.api.openMcpUserFile().catch((e: unknown) => onError(why(e)))} title={listing.userFile}>
            File dei miei server
          </button>
          <button type="button" className="ghost sm" onClick={() => window.api.openMcpConfig().catch((e: unknown) => onError(why(e)))}>
            config/mcp.json
          </button>
        </div>
      )}
    </details>
  )
}
