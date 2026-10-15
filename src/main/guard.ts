import { shell, type Session, type WebContents } from 'electron'

/** https only, host equal to or a subdomain of an allowed host. */
export function hostAllowed(url: string, allowedHosts: string[]): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return u.protocol === 'https:' && allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))
}

/** Provider pages are untrusted: no camera/mic/notifications, no navigation off the allowlist, no popups. */
export function lockSession(s: Session): void {
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  s.setPermissionCheckHandler(() => false)
}

export function guardNavigation(wc: WebContents, allowedHosts: string[]): void {
  const block = (e: { url: string; preventDefault(): void }): void => {
    if (!hostAllowed(e.url, allowedHosts)) e.preventDefault()
  }
  wc.on('will-navigate', block)
  wc.on('will-redirect', block)
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
}
