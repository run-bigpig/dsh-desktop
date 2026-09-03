import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineOpenPencilControlTools } from '../src/openpencil/control-tools.ts'
import { startEmbeddedOpenPencilServer } from '../src/openpencil/index.ts'
import { registerOpenPencilSkill } from '../src/openpencil/skill.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('OpenPencil built-in integration', () => {
  it('starts the official MCP runtime on an authenticated ephemeral port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starweave-openpencil-'))
    temporaryDirectories.push(root)
    const server = await startEmbeddedOpenPencilServer('test-token', root)
    try {
      expect(server.httpPort).toBeGreaterThan(0)
      const health = await fetch(`http://127.0.0.1:${server.httpPort}/health`)
      await expect(health.json()).resolves.toMatchObject({ status: 'no_app', authRequired: true })
      const unauthorized = await fetch(`http://127.0.0.1:${server.httpPort}/mcp`, { method: 'POST' })
      expect(unauthorized.status).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('registers agent-only canvas visibility controls', async () => {
    const show = vi.fn(async () => 'shown')
    const hide = vi.fn(async () => 'hidden')
    const tools = defineOpenPencilControlTools({ show, hide })
    expect(tools.map(tool => tool.name)).toEqual(['openpencil_show', 'openpencil_hide'])
    await tools[0]?.execute({})
    await tools[1]?.execute({})
    expect(show).toHaveBeenCalledOnce()
    expect(hide).toHaveBeenCalledOnce()
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
    expect(skill?.content).toContain('没有 Companion 应用')
    expect(skill?.content).toContain('内置 OpenPencil MCP Runtime 未连接')
    expect(skill?.content).toContain('.fig')
    expect(skill?.resourceBase.path).toMatch(/openpencil-design[/\\]$/)
  })
})
