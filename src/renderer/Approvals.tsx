import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '@contracts/permissions'
import { DiffView } from './DiffView'

const BADGE: Record<ApprovalRequest['kind'], string> = {
  write: 'Modifica file',
  bash: 'Comando shell',
  mcp: 'Chiamata MCP',
  outside: 'Fuori dalla cartella di lavoro'
}

/** Shows the first pending request. The agent is blocked until it is answered. */
export function Approvals() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const cur = queue[0]

  useEffect(() => window.api.onApproval((r) => setQueue((q) => [...q, r])), [])
  useEffect(
    () =>
      window.api.onEvent((e) => {
        if (e.type === 'finished') setQueue([])
      }),
    []
  )

  // Busy guard: a second click must not answer the next request, which the user has not seen yet.
  const answer = async (allow: boolean) => {
    if (!cur || busy) return
    setBusy(true)
    setErr('')
    try {
      await window.api.answerApproval(cur.id, allow)
      setQueue((q) => q.filter((r) => r.id !== cur.id))
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  // Esc works even when the focus has left the dialog (buttons get disabled while busy).
  useEffect(() => {
    if (!cur) return
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void answer(false)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [cur, busy])

  if (!cur) return null
  return (
    <div className="overlay">
      <div className="dialog" role="alertdialog" aria-modal="true" key={cur.id}>
        <span className={`badge ${cur.kind}`}>{BADGE[cur.kind]}</span>
        {cur.agent && <strong className="asked-by">Richiesta da: {cur.agent}</strong>}
        <strong>{cur.summary}</strong>
        {cur.outside && <div className="outside-warn">Tocca percorsi FUORI dalla cartella di lavoro</div>}
        {cur.kind === 'bash' || cur.kind === 'mcp' ? <pre>{cur.detail}</pre> : <DiffView text={cur.detail} />}
        {queue.length > 1 && <div className="hint">Altre {queue.length - 1} richieste in coda</div>}
        {err && <div className="error">{err}</div>}
        <div className="buttons">
          <button autoFocus className="danger" onClick={() => answer(false)} disabled={busy}>
            Nega
          </button>
          <button className="primary" onClick={() => answer(true)} disabled={busy}>
            Consenti
          </button>
        </div>
      </div>
    </div>
  )
}
