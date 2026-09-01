import { describe, expect, it, vi } from 'vitest'
import {
  emptyOpenPencilDocument,
  parseOpenPencilDocument,
  serializeOpenPencilDocument,
} from '../src/openpencil/document.ts'
import { registerOpenPencilSkill } from '../src/openpencil/skill.ts'

describe('OpenPencil settings document', () => {
  it('defaults to disabled and round-trips the enabled state', () => {
    expect(emptyOpenPencilDocument()).toEqual({ version: 1, enabled: false })
    expect(parseOpenPencilDocument(serializeOpenPencilDocument({ version: 1, enabled: true }))).toEqual({
      version: 1,
      enabled: true,
    })
  })

  it('loads the packaged OpenPencil skill with MCP workflow references', async () => {
    const register = vi.fn(() => () => {})
    await registerOpenPencilSkill({ skills: { register } } as never)
    expect(register).toHaveBeenCalledOnce()
    const skill = register.mock.calls[0]?.[0]
    expect(skill?.name).toBe('openpencil-design')
    expect(skill?.whenToUse).toContain('OpenPencil')
    expect(skill?.content).toContain('# OpenPencil 设计协作')
    expect(skill?.content).toContain('mcp__openpencil-mcp__batch_design')
    expect(skill?.content).toContain('事务性的')
    expect(skill?.resourceBase.path).toMatch(/openpencil-design[/\\]$/)
  })

  it('rejects unknown fields and invalid versions', () => {
    expect(() => parseOpenPencilDocument('{"version":1,"enabled":true,"token":"secret"}')).toThrow('unknown fields')
    expect(() => parseOpenPencilDocument('{"version":2,"enabled":true}')).toThrow('invalid shape')
  })
})
