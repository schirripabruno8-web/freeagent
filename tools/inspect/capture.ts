import type { DomReport } from './inspect-script'

export type CaptureReason = 'first' | 'composer-change' | 'final'
export interface Kept {
  report: DomReport
  atMs: number
  reason: CaptureReason
}

// Cambia tra freccia di invio e quadrato di stop, e tra abilitato e disabilitato.
export function composerSignature(report: DomReport): string {
  return JSON.stringify(report.candidates.sendButton.map((b) => [b.classes, b.svgSig, b.disabled, b.ariaLabel]))
}

export class AutoCapture {
  private readonly maxKept: number
  private items: Kept[] = []

  constructor(opts: { maxKept?: number } = {}) {
    this.maxKept = opts.maxKept ?? 8
  }

  push(report: DomReport, atMs: number): { keep: boolean; reason: 'first' | 'composer-change' | null } {
    const last = this.items.at(-1)
    if (!last) {
      this.items.push({ report, atMs, reason: 'first' })
      return { keep: true, reason: 'first' }
    }
    // Il confronto e' con l'ultimo TENUTO, non con l'ultimo visto.
    if (this.items.length >= this.maxKept || composerSignature(report) === composerSignature(last.report)) {
      return { keep: false, reason: null }
    }
    this.items.push({ report, atMs, reason: 'composer-change' })
    return { keep: true, reason: 'composer-change' }
  }

  // Il finale va aggiunto anche oltre il limite: e' lo stato a fine cattura.
  finish(report: DomReport, atMs: number): void {
    if (this.items.some((k) => k.report === report)) return
    this.items.push({ report, atMs, reason: 'final' })
  }

  kept(): Kept[] {
    return this.items.slice()
  }
}
