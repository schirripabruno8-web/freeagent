export type ProviderErrorKind =
  | 'rate_limit'
  | 'login_required'
  | 'captcha'
  | 'network'
  | 'selector_broken'
  | 'timeout'
  /** The provider stopped mid-answer or dropped the message (server error): resending usually works. */
  | 'interrupted'
  | 'aborted'

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export interface ModelInfo {
  id: string
  label: string
}

/** Full text of the current reply so far. `text` has code blocks rebuilt as ``` fences. */
export interface StreamSnapshot {
  text: string
  done: boolean
}

export interface AdapterStatus {
  loggedIn: boolean | 'unknown'
  url: string
  error?: ProviderErrorKind
}

export interface SelfTestReport {
  ok: boolean
  checks: { name: string; ok: boolean; detail?: string }[]
}

export interface ProviderAdapter {
  readonly id: string
  status(): Promise<AdapterStatus>
  /** Models actually offered by the page's own selector. */
  listModels(): Promise<ModelInfo[]>
  selectModel(modelId: string): Promise<void>
  newChat(): Promise<void>
  /** Types and submits (with images, if given: absolute paths). Records the assistant-message count so stream() ignores older replies. Throws ProviderError. */
  send(text: string, images?: string[]): Promise<void>
  /** Yields snapshots until the reply is finished. Throws ProviderError (rate_limit, timeout, aborted...). */
  stream(signal?: AbortSignal): AsyncIterable<StreamSnapshot>
  /** Checks that every configured selector resolves on the current page. */
  selfTest(): Promise<SelfTestReport>
}
