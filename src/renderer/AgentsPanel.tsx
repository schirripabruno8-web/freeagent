import { useState } from 'react'
import type { AgentRow } from './agents-state'

const LABEL: Record<AgentRow['status'], string> = {
  queued: 'In coda',
  running: 'In esecuzione',
  done: 'Finito',
  error: 'Errore',
  stopped: 'Fermato'
}

const cut = (s: string) => (s.length > 80 ? s.slice(0, 79) + '…' : s)

/** One row per agent of the current task. Hidden until there is a row. */
export function AgentsPanel({ rows }: { rows: AgentRow[] }) {
  const [err, setErr] = useState('')
  if (rows.length === 0) return null

  const show = (r: AgentRow) => {
    setErr('')
    const shown = r.id === 'main' ? window.api.showProvider(r.provider) : window.api.showSession(r.id)
    shown.catch((e: unknown) => setErr(String(e)))
  }

  return (
    <section className="agents" aria-label="Agenti">
      <div className="agent-chips">
        {rows.map((r) => {
          const inner = (
            <>
              <span className={`dot ${r.status}`} role="img" aria-label={LABEL[r.status]} />
              <strong>{r.name}</strong>
              <span className="muted">{r.provider}</span>
              <span className="muted">{LABEL[r.status]}</span>
              {r.note && <span className="note" title={r.note}>{cut(r.note)}</span>}
            </>
          )
          return r.id === 'main' || r.status === 'running' ? (
            <button key={r.id} type="button" className="agent-chip" title="Mostra la sua chat a destra" onClick={() => show(r)}>
              {inner}
            </button>
          ) : (
            <span key={r.id} className="agent-chip static">
              {inner}
            </span>
          )
        })}
      </div>
      {err && <div className="error small">{err}</div>}
    </section>
  )
}
