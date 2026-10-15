import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
const { hostAllowed } = await import('./guard')

describe('hostAllowed', () => {
  const allowed = ['chat.deepseek.com']
  it('accepts the host and its subdomains over https', () => {
    expect(hostAllowed('https://chat.deepseek.com/a/b?c=1', allowed)).toBe(true)
    expect(hostAllowed('https://x.chat.deepseek.com/', allowed)).toBe(true)
  })
  it('rejects look-alikes, other schemes and garbage', () => {
    for (const u of [
      'https://evilchat.deepseek.com/',
      'https://chat.deepseek.com.evil.io/',
      'https://deepseek.com/',
      'http://chat.deepseek.com/',
      'file:///C:/x',
      'javascript:alert(1)',
      'not a url'
    ]) expect(hostAllowed(u, allowed), u).toBe(false)
  })
})

describe('sign-in hosts (config/providers.json)', () => {
  const providers = JSON.parse(readFileSync(fileURLToPath(new URL('../../config/providers.json', import.meta.url)), 'utf8')) as { id: string; url: string; loginHosts?: string[] }[]
  const meta = providers.find((p) => p.id === 'meta')!
  // the same list the app builds for a view: the page's own host plus the sign-in hosts
  const allowed = [new URL(meta.url).hostname, ...(meta.loginHosts ?? [])]

  it('Meta AI can follow its sign-in (meta.ai -> auth.meta.com -> facebook.com / instagram.com) and nothing else', () => {
    expect(hostAllowed('https://www.meta.ai/api/oidc/start', allowed)).toBe(true)
    expect(hostAllowed('https://auth.meta.com/oidc?x=1', allowed)).toBe(true)
    expect(hostAllowed('https://www.facebook.com/login.php', allowed)).toBe(true)
    expect(hostAllowed('https://www.instagram.com/accounts/login/', allowed)).toBe(true)
    for (const u of ['https://evilmeta.com/', 'https://facebook.com.evil.io/', 'http://www.facebook.com/', 'https://example.com/']) expect(hostAllowed(u, allowed), u).toBe(false)
  })

  it('only providers whose sign-in leaves their site declare loginHosts (the rest stay locked to one host)', () => {
    expect(providers.filter((p) => p.loginHosts).map((p) => p.id)).toEqual(['meta'])
  })
})
