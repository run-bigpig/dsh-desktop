import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_THINKINGDATA_URL,
  effectiveThinkingDataUrl,
  emptyThinkingDataDocument,
  parseThinkingDataDocument,
  serializeThinkingDataDocument,
  validateThinkingDataUrl,
} from '../src/thinkingdata/document.ts'
import { isReservedMcpServerName } from '../src/mcp/document.ts'
import { registerThinkingDataSkill } from '../src/thinkingdata/skill.ts'

describe('ThinkingData settings document', () => {
  it('uses the built-in URL while preserving an empty stored override', () => {
    const document = emptyThinkingDataDocument()
    expect(document).toEqual({ version: 1, enabled: false, url: '' })
    expect(effectiveThinkingDataUrl(document.url)).toBe(DEFAULT_THINKINGDATA_URL)
    expect(parseThinkingDataDocument(serializeThinkingDataDocument(document))).toEqual(document)
  })

  it('accepts HTTP endpoints and rejects credentials or unsupported protocols', () => {
    expect(() => validateThinkingDataUrl('https://analytics.example/mcp')).not.toThrow()
    expect(() => validateThinkingDataUrl('https://user:secret@analytics.example/mcp')).toThrow()
    expect(() => validateThinkingDataUrl('file:///tmp/mcp')).toThrow()
  })

  it('reserves the internal server name from generic MCP settings', () => {
    expect(isReservedMcpServerName('ta-mcp-server')).toBe(true)
    expect(isReservedMcpServerName('other-server')).toBe(false)
  })

  it('loads the packaged skill with its reference directory', async () => {
    const register = vi.fn(() => () => {})
    await registerThinkingDataSkill({ skills: { register } } as never)
    expect(register).toHaveBeenCalledOnce()
    const skill = register.mock.calls[0]?.[0]
    expect(skill?.name).toBe('thinkingdata-analysis-orchestrator')
    expect(skill?.content).toContain('# ThinkingData 分析编排')
    expect(skill?.resourceBase.path).toMatch(/thinkingdata-analysis-orchestrator[/\\]$/)
  })
})
