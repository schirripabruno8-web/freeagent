export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

/** Intestazioni git (diff --git, index, modalita', rename...) e la marca "\ No newline at end of file": non sono contenuto. */
const HEADER = /^(diff |index |new file mode|deleted file mode|old mode|new mode|similarity index|rename |copy |Binary files |\\ No newline)/

function kindOf(line: string): DiffLineKind {
  // shortcut: una riga cancellata che inizia con "--" (o aggiunta con "++") esce come "---"/"+++" e viene letta come meta, upgrade: parser che conta le righe degli hunk
  if (line.startsWith('+++') || line.startsWith('---') || HEADER.test(line)) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

/** Pure: one entry per line. A trailing newline does not add an empty line. */
export function classifyDiffLines(text: string): { kind: DiffLineKind; text: string }[] {
  if (text === '') return []
  return text.replace(/\r?\n$/, '').split(/\r?\n/).map((line) => ({ kind: kindOf(line), text: line }))
}
