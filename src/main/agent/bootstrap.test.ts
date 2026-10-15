import { describe, expect, it } from 'vitest'
import { buildBootstrap } from './bootstrap'

describe('MCP nel primo messaggio', () => {
  it('spiega con un esempio che il "tool" esterno e sempre mcp_call e il nome del tool MCP va in args.tool (i modelli deboli li confondono)', () => {
    const text = buildBootstrap([], 3, [], [{ name: 'blender', tools: ['execute_python'] }])
    expect(text).toContain('The outer "tool" is ALWAYS "mcp_call"')
    expect(text).toContain('"args": {"server": "<server>", "tool": "<mcp tool>"')
    expect(buildBootstrap([], 3)).not.toContain('mcp_call')
  })
})
