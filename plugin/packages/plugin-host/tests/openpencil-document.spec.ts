import { describe, expect, it, vi } from 'vitest'
import { defineOpenPencilControlTools } from '../src/openpencil/control-tools.ts'
import { registerOpenPencilSkill } from '../src/openpencil/skill.ts'

describe('OpenPencil built-in integration', () => {
  it('registers agent-only canvas visibility controls', () => {
    const tools = defineOpenPencilControlTools({ show: vi.fn(), hide: vi.fn() })
    expect(tools.map(tool => tool.name)).toEqual(['openpencil_show', 'openpencil_hide'])
  })

  it('loads the packaged OpenPencil skill with MCP workflow references', async () => {
    const register = vi.fn(() => () => {})
    await registerOpenPencilSkill({ skills: { register } } as never)
    expect(register).toHaveBeenCalledOnce()
    const skill = register.mock.calls[0]?.[0]
    expect(skill?.name).toBe('openpencil-design')
    expect(skill?.whenToUse).toContain('OpenPencil')
    expect(skill?.content).toContain('# OpenPencil 设计协作')
    expect(skill?.content).toContain('openpencil_show')
    expect(skill?.content).toContain('document_id')
    expect(skill?.content).toContain('create_page')
    expect(skill?.content).toContain('503')
    expect(skill?.content).toContain('.fig')
    expect(skill?.resourceBase.path).toMatch(/openpencil-design[/\\]$/)
  })
})
