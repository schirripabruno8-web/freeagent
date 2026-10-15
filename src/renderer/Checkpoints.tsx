import { useEffect, useState } from 'react'
import type { CheckpointInfo } from '@contracts/permissions'

const base = (p: string) => p.split(/[\\/]/).pop() ?? p
const names = (files: string[]) =>
  files.slice(0, 3).map(base).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : '')

export function Checkpoints({ disabled }: { disabled: boolean }) {
  const [list, setList] = useState<CheckpointInfo[]>([])
  const [confirming, setConfirming] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const refresh = () => window.api.listCheckpoints().then(setList, (e: unknown) => setErr(String(e)))

  useEffect(() => {
    void refresh()
    // Any tool result can create a checkpoint, so every one refreshes the list.
    return window.api.onEvent((e) => {
      if (e.type === 'finished' || e.type === 'tool_result') void refresh()
    })
  }, [])

  // Two clicks: the first only asks for confirmation.
  const restore = async (id: string) => {
    setConfirming('')
    setMsg('')
    setErr('')
    setBusy(true)
    try {
      const { restored } = await window.api.restoreCheckpoint(id)
      setMsg(`Ripristinati ${restored.length} file`)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  return (
    <details className="checkpoints">
      <summary>Checkpoint ({list.length})</summary>
      {list.length === 0 && <div className="hint">Nessun checkpoint.</div>}
      <ul>
        {list
          .toSorted((a, b) => b.ts - a.ts)
          .map((c) => (
            <li key={c.id}>
              <span className="muted">{new Date(c.ts).toLocaleTimeString('it-IT')}</span>
              <span>{c.tool}</span>
              <span className="muted">{names(c.files)}</span>
              <button
                disabled={busy || disabled}
                title={disabled ? 'Ferma il task prima di ripristinare' : undefined}
                onClick={() => (confirming === c.id ? restore(c.id) : setConfirming(c.id))}
              >
                {confirming === c.id ? 'Sicuro? Annulla le modifiche successive' : 'Ripristina fino a qui'}
              </button>
            </li>
          ))}
      </ul>
      {msg && <div className="status">{msg}</div>}
      {err && <div className="error">{err}</div>}
    </details>
  )
}
