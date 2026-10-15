import { useEffect, useState } from 'react'
import type { PonytailMode, SkillInfo } from '@contracts/skills'

const LEVELS: [PonytailMode, string][] = [
  ['off', 'Spento'],
  ['lite', 'Lite'],
  ['full', 'Full'],
  ['ultra', 'Ultra']
]

export function SkillsPanel({ onError }: { onError(message: string): void }) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mode, setMode] = useState<PonytailMode>('full')

  const readMode = () => window.api.getPonytail().then(setMode, (e: unknown) => onError(String(e)))

  useEffect(() => {
    window.api.listSkills().then(setSkills, (e: unknown) => onError(String(e)))
    void readMode()
    // `/ponytail ultra` or `stop ponytail` typed as a task changes the level behind the UI's back: follow it.
    return window.api.onEvent((e) => {
      if ((e.type === 'status' && e.text.startsWith('ponytail:')) || (e.type === 'finished' && !e.agent)) void readMode()
    })
  }, [])

  const change = (m: PonytailMode) => {
    setMode(m)
    window.api.setPonytail(m).catch((e: unknown) => onError(String(e)))
  }

  return (
    <details className="skills">
      <summary>
        Skill ({skills.length}) · ponytail: {LEVELS.find(([m]) => m === mode)?.[1] ?? mode}
      </summary>
      <label>
        Ponytail: regole sempre attive per tutti gli agenti
        <select value={mode} onChange={(e) => change(e.target.value as PonytailMode)}>
          {LEVELS.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="hint">Nel task puoi scrivere /ponytail ultra oppure "stop ponytail".</div>
      <ul>
        {skills.map((s) => (
          <li key={s.name}>
            <strong>{s.name}</strong> <span className="muted">{s.source === 'bundled' ? 'inclusa' : 'tua'}</span>
            <div className="hint">{s.description}</div>
          </li>
        ))}
      </ul>
    </details>
  )
}
