import { classifyDiffLines } from './diff-lines'

export function DiffView({ text }: { text: string }) {
  return (
    <div className="diff">
      {classifyDiffLines(text).map((l, i) => (
        // An empty line needs a space to keep its height.
        <div key={i} className={`dl ${l.kind}`}>
          {l.text || ' '}
        </div>
      ))}
    </div>
  )
}
