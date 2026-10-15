import { useEffect, useState } from 'react'
import type { ProviderInfo } from '@contracts/ipc'
import type { ModelEntry } from '@contracts/models'
import type { ModelInfo } from '@contracts/provider'
import { filterModels } from './models-filter'

const CAP: Record<ModelEntry['capabilities'][number], string> = {
  code: 'codice',
  reasoning: 'ragionamento',
  'long-context': 'contesto lungo',
  tools: 'tool',
  vision: 'immagini'
}

const REL: Record<ModelEntry['toolReliability'], string> = {
  good: 'tool: affidabile',
  fair: 'tool: discreto',
  poor: 'tool: scarso',
  unknown: 'tool: non provato'
}

export function ModelPicker({
  provider,
  value,
  onChange
}: {
  provider: ProviderInfo | undefined
  value: string
  onChange(modelId: string): void
}) {
  const pid = provider?.id ?? ''
  const [models, setModels] = useState<ModelEntry[]>([])
  const [query, setQuery] = useState('')
  const [onlyReliable, setOnlyReliable] = useState(false)
  const [pageModels, setPageModels] = useState<ModelInfo[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    window.api.listModels().then(setModels, (e: unknown) => setErr(String(e)))
  }, [])

  // The chosen model may not exist for the new provider: fall back to the page's default.
  useEffect(() => {
    setPageModels([])
    setErr('')
    if (value !== 'default' && !models.some((m) => m.provider === pid && m.id === value)) onChange('default')
  }, [pid])

  const registry = models.filter((m) => m.provider === pid)
  const sel = registry.find((m) => m.id === value)
  const shown = filterModels(models, { provider: pid, query, onlyReliable })
  // Keep the selected model listed even when the filters hide it: otherwise the select shows another one.
  const list = sel && !shown.includes(sel) ? [sel, ...shown] : shown
  const extra = pageModels.filter((p) => !registry.some((m) => m.id === p.id))

  const readPage = () => {
    setErr('')
    window.api.listPageModels(pid).then(setPageModels, (e: unknown) => setErr(String(e)))
  }

  return (
    <div className="model-picker">
      <label className="field">
        <span>Modello</span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {extra.length > 0 && (
            <optgroup label="Dalla pagina">
              {extra.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {provider?.modelPicker && (
        <button type="button" className="ghost sm" onClick={readPage}>
          Leggi i modelli dalla pagina
        </button>
      )}
      {err && <div className="error">{err}</div>}
      {/* Closed by default: search, filter and details are rarely needed and push the log out of view. */}
      <details className="model-more">
        <summary>Cerca, filtra e dettagli del modello</summary>
        <label className="field">
          <span>Cerca modello</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="nome, capacità, note" />
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyReliable} onChange={(e) => setOnlyReliable(e.target.checked)} />
          solo con tool affidabili
        </label>
        {sel && (
          <>
            <div className="chips">
              {sel.capabilities.map((c) => (
                <span key={c} className="badge">
                  {CAP[c]}
                </span>
              ))}
              <span className={`badge ${sel.toolReliability}`}>{REL[sel.toolReliability]}</span>
            </div>
            {sel.limits && <div className="hint">Limiti: {sel.limits}</div>}
            {sel.notes && <div className="hint">{sel.notes}</div>}
          </>
        )}
      </details>
    </div>
  )
}
