import { describe, expect, it } from 'vitest'
import { cleanName, deriveName, parseSnippet, splitCommandLine } from './snippet'

describe('nomi', () => {
  it('un pacchetto o un indirizzo diventano un nome digitabile', () => {
    expect(deriveName('npx', ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\dati'])).toBe('filesystem')
    expect(deriveName('npx', ['-y', 'github-mcp-server@1.2.3'])).toBe('github')
    expect(deriveName('uvx', ['mcp-server-fetch'])).toBe('fetch')
    expect(deriveName('node', ['C:\\mio\\server.js'])).toBe('server')
    expect(deriveName('python', ['-m', 'mio_server'])).toBe('mio') // flags are skipped, "server" suffix dropped
    expect(deriveName(undefined, [], 'https://mcp.example.com/mcp')).toBe('example')
    expect(deriveName(undefined, [], 'non un url')).toBe('server')
  })

  it('cleanName: minuscole, cifre, - e _, inizia con una lettera, al massimo 32 caratteri', () => {
    expect(cleanName('My Server!')).toBe('my-server')
    expect(cleanName('123abc')).toBe('mcp-123abc')
    expect(cleanName('')).toBe('server')
    expect(cleanName('x'.repeat(50))).toHaveLength(32)
    expect(cleanName('---')).toBe('server')
  })
})

describe('splitCommandLine', () => {
  it('apici e virgolette raggruppano, i percorsi Windows con backslash restano interi', () => {
    expect(splitCommandLine('npx -y pkg "C:\\Mia cartella\\dati" \'a b\'')).toEqual(['npx', '-y', 'pkg', 'C:\\Mia cartella\\dati', 'a b'])
    expect(splitCommandLine('  a   b  ')).toEqual(['a', 'b'])
    expect(splitCommandLine('cmd ""')).toEqual(['cmd', ''])
    expect(splitCommandLine('')).toEqual([])
  })
})

describe('parseSnippet: JSON', () => {
  it('formato Claude Desktop / Cursor: piu server, env e argomenti', () => {
    const r = parseSnippet(JSON.stringify({ mcpServers: { Files: { command: 'npx', args: ['-y', '@x/server-filesystem', 'D:\\w'], env: { TOKEN: 'abc', N: 3 } }, web: { url: 'https://h.example/mcp' } } }))
    expect(r.error).toBeUndefined()
    expect(r.candidates).toEqual([
      { name: 'files', config: { type: 'stdio', command: 'npx', args: ['-y', '@x/server-filesystem', 'D:\\w'], env: { TOKEN: 'abc', N: '3' } } },
      { name: 'web', config: { type: 'http', url: 'https://h.example/mcp' } }
    ])
  })

  it('formato VS Code ("servers"), un solo server senza nome, mappa nuda e frammento senza graffe esterne', () => {
    expect(parseSnippet('{"servers":{"a":{"command":"node","args":["s.js"]}}}').candidates.map((c) => c.name)).toEqual(['a'])
    const single = parseSnippet('{"command":"uvx","args":["mcp-server-fetch"]}')
    expect(single.candidates).toHaveLength(1)
    expect(single.candidates[0]!.name).toBe('fetch')
    expect(parseSnippet('{"a":{"command":"x"},"b":{"url":"https://u.example/"}}').candidates.map((c) => c.name)).toEqual(['a', 'b'])
    expect(parseSnippet('"git": { "command": "uvx", "args": ["mcp-server-git"] },').candidates.map((c) => c.name)).toEqual(['git'])
  })

  it('le note avvisano di cio che non si capisce: sse, intestazioni; il resto non entra', () => {
    const r = parseSnippet('{"mcpServers":{"r":{"type":"sse","url":"https://r.example/sse","headers":{"Authorization":"Bearer x"}}}}')
    expect(r.candidates[0]!.config).toEqual({ type: 'http', url: 'https://r.example/sse' })
    expect(r.candidates[0]!.notes).toHaveLength(2)
    expect(JSON.stringify(r)).not.toContain('Bearer') // headers are dropped, never carried along
  })

  it('errori chiari: JSON rotto, oggetto senza server, voci senza comando ne url (le altre restano)', () => {
    expect(parseSnippet('{ rotto').error).toMatch(/not valid JSON/)
    expect(parseSnippet('{"x": 1}').error).toMatch(/no server found/)
    expect(parseSnippet('[1,2]').error).toBeDefined()
    const mixed = parseSnippet('{"mcpServers":{"ok":{"command":"x"},"bad":{"args":[]},"worse":5}}')
    expect(mixed.candidates.map((c) => c.name)).toEqual(['ok'])
    expect(mixed.error).toMatch(/bad.*worse|worse.*bad/s)
    expect(parseSnippet('').error).toMatch(/nothing to read/)
    expect(parseSnippet('   ').candidates).toEqual([])
  })
})

describe('parseSnippet: comando, claude mcp add, indirizzo', () => {
  it('una riga di comando: il primo pezzo e il programma', () => {
    const r = parseSnippet('npx -y @modelcontextprotocol/server-filesystem "C:\\Mia cartella"')
    expect(r.candidates).toEqual([{ name: 'filesystem', config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Mia cartella'] } }])
  })

  it('claude mcp add: nome, variabili, comando dopo "--"; e la forma http', () => {
    const r = parseSnippet('claude mcp add --scope user -e API_KEY=k1 github -- npx -y @x/github-mcp')
    expect(r.candidates).toEqual([{ name: 'github', config: { type: 'stdio', command: 'npx', args: ['-y', '@x/github-mcp'], env: { API_KEY: 'k1' } } }])
    const http = parseSnippet('claude mcp add --transport http notion https://mcp.notion.example/mcp')
    expect(http.candidates).toEqual([{ name: 'notion', config: { type: 'http', url: 'https://mcp.notion.example/mcp' } }])
    expect(parseSnippet('claude mcp add solo').error).toMatch(/command is missing/)
  })

  it('un indirizzo da solo e un server http con il nome ricavato dal sito', () => {
    expect(parseSnippet('https://mcp.example.com/mcp').candidates).toEqual([{ name: 'example', config: { type: 'http', url: 'https://mcp.example.com/mcp' } }])
  })
})
