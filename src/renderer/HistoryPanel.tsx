import { useEffect, useState } from 'react'
import type { HistoryMeta } from '@contracts/history'
import { groupByDay, matches, whenLabel } from './history-view'
import { Icon } from './Icons'

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const STATUS = { done: 'Finito', error: 'Errore', stopped: 'Fermato' } as const

/** Past chats on this PC. Opening one shows its conversation and the provider's page of that chat, ready for "Continua". */
export function HistoryPanel({
  version,
  running,
  activeId,
  onOpen,
  onCount,
  onError
}: {
  version: number
  running: boolean
  activeId?: string
  onOpen(meta: HistoryMeta): void
  onCount(n: number): void
  onError(message: string): void
}) {
  const [list, setList] = useState<HistoryMeta[]>([])
  const [query, setQuery] = useState('')
  const [confirming, setConfirming] = useState('')

  useEffect(() => {
    window.api.listHistory().then(
      (l) => {
        setList(l)
        onCount(l.length)
      },
      (e: unknown) => onError(String(e))
    )
  }, [version])

  const remove = (id: string) => {
    setConfirming('')
    window.api.deleteHistory(id).then(
      () => {
        const next = list.filter((m) => m.id !== id)
        setList(next)
        onCount(next.length)
      },
      (e: unknown) => onError(String(e))
    )
  }

  const shown = list.filter((m) => matches(m, query))
  return (
    <div className="history">
      <label className="search">
        <Icon name="search" size={15} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cerca nelle chat passate" />
      </label>
      {list.length === 0 && (
        <div className="empty">
          <Icon name="chat" size={26} />
          <strong>Nessuna chat ancora</strong>
          <span>Ogni task che avvii compare qui, con la conversazione e i comandi eseguiti.</span>
        </div>
      )}
      {list.length > 0 && shown.length === 0 && <div className="hint">Nessuna chat corrisponde a “{query}”.</div>}
      {groupByDay(shown).map((g) => (
        <section key={g.label} className="group">
          <h3>{g.label}</h3>
          {g.items.map((m) => (
            <div key={m.id} className={`chat-card${m.id === activeId ? ' active' : ''}`}>
              <button
                type="button"
                className="open"
                disabled={running}
                title={running ? 'Ferma il task prima di aprire un’altra chat' : 'Apri la chat'}
                onClick={() => onOpen(m)}
              >
                <span className={`prov ${m.provider}`}>{m.provider.slice(0, 2)}</span>
                <span className="body">
                  <span className="title">{m.title}</span>
                  <span className="meta">
                    <span className={`dot ${m.status === 'done' ? 'done' : m.status === 'stopped' ? 'stopped' : 'error'}`} title={STATUS[m.status]} />
                    {whenLabel(m.updatedAt)} · {base(m.cwd)}
                    {m.runs > 1 ? ` · ${m.runs} richieste` : ''}
                  </span>
                  <span className="sum">{m.summary}</span>
                </span>
              </button>
              {confirming === m.id ? (
                <button type="button" className="danger sm" onClick={() => remove(m.id)}>
                  Elimina
                </button>
              ) : (
                <button type="button" className="ghost icon del" title="Elimina dalla cronologia" onClick={() => setConfirming(m.id)} onBlur={() => setConfirming('')}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
