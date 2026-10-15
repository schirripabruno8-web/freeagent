import { DiffView } from './DiffView'
import { Icon } from './Icons'
import type { LogItem } from './log'
import { argPreview, splitBlocks } from './text-blocks'

/** The conversation as a timeline: what the user asked, what the model said, each tool call as one row. */
export function LogView({ items }: { items: LogItem[] }) {
  // Append-only list: index keys are stable, and assistant items are rewritten in place.
  return (
    <>
      {items.map((item, i) => (
        <Entry key={i} item={item} />
      ))}
    </>
  )
}

function Entry({ item }: { item: LogItem }) {
  if (!item.agent) return <Body item={item} />
  return (
    <div className="sub">
      <span className="agent-tag">{item.agent}</span>
      <Body item={item} />
    </div>
  )
}

function Body({ item }: { item: LogItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="who">
            <Icon name="user" size={13} /> {item.resume ? 'Tu · seguito nella stessa chat' : 'Tu'}
          </div>
          <div className="bubble">{item.text}</div>
          {item.images ? (
            <div className="chip-line">
              <Icon name="image" size={13} /> {item.images} {item.images === 1 ? 'immagine allegata' : 'immagini allegate'}
            </div>
          ) : null}
        </div>
      )
    case 'assistant':
      return <Assistant text={item.text} done={item.done} />
    case 'status':
      return <div className="status">{item.text}</div>
    case 'error':
      return (
        <div className="notice error">
          <Icon name="x" size={14} /> <span>{item.text}</span>
        </div>
      )
    case 'finished':
      return (
        <div className={`notice finished ${item.report.reason === 'finish' ? 'ok' : item.report.reason === 'aborted' ? 'warn' : 'error'}`}>
          <Icon name={item.report.reason === 'finish' ? 'check' : 'x'} size={14} />
          <div>
            <div>{item.report.summary}</div>
            <div className="muted small">
              {item.report.reason === 'finish' ? 'Finito' : item.report.reason === 'aborted' ? 'Fermato' : item.report.reason} · {item.report.steps} passi
            </div>
          </div>
        </div>
      )
    case 'tool_call': {
      const state = !item.result ? 'pending' : item.result.ok ? 'ok' : 'bad'
      return (
        <details className="tool">
          <summary>
            <span className={`state ${state}`} />
            <Icon name="wrench" size={13} />
            <b>{item.call.tool}</b>
            <span className="arg">{argPreview(item.call.args)}</span>
          </summary>
          <pre>{JSON.stringify(item.call.args, null, 2)}</pre>
          {item.result && <Output ok={item.result.ok} output={item.result.output} />}
        </details>
      )
    }
    case 'tool_result':
      return (
        <details className="tool">
          <summary>
            <span className={`state ${item.ok ? 'ok' : 'bad'}`} />
            <Icon name="wrench" size={13} />
            <b>risultato</b>
          </summary>
          <Output ok={item.ok} output={item.output} />
        </details>
      )
  }
}

function Assistant({ text, done }: { text: string; done: boolean }) {
  const blocks = splitBlocks(text)
  return (
    <div className={`msg assistant${done ? '' : ' live'}`}>
      <span className="avatar">
        <Icon name="bot" size={15} />
      </span>
      <div className="bubble">
        {blocks.length === 0 && !done && <span className="thinking">sta pensando…</span>}
        {blocks.map((b, i) =>
          b.kind === 'text' ? (
            <p key={i}>{b.text}</p>
          ) : b.lang === 'tool' ? (
            <details key={i} className="cmd">
              <summary>comando{b.open ? ' (in scrittura…)' : ''}</summary>
              <pre>{b.text}</pre>
            </details>
          ) : (
            <pre key={i} className="code">
              {b.text}
            </pre>
          )
        )}
      </div>
    </div>
  )
}

function Output({ ok, output }: { ok: boolean; output: string }) {
  if (/^@@ /m.test(output)) return <DiffView text={output} />
  return <pre className={ok ? undefined : 'error'}>{output}</pre>
}
