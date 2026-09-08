import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { McpSettingsGateway } from '../src/mcp/index.ts'
import { blenderMcpRecord, migrateBlenderMcpDefaults } from '../src/mcp/blender.ts'
import type { McpSettingsDocument } from '../src/mcp/document.ts'

const lifecycle = vi.hoisted(() => ({ starts: [] as string[], stops: [] as string[] }))
vi.mock('@deepseek-ai/dsh-mcp-client', async importOriginal => ({
  ...await importOriginal<object>(),
  inject: [],
  apply: (ctx: Context, config: { serverName: string }) => {
    lifecycle.starts.push(config.serverName)
    ctx.effect(() => () => { lifecycle.stops.push(config.serverName) })
  },
}))

it('migrates saved Blender defaults through startup without changing enablement or other settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starweave-mcp-defaults-'))
  const path = join(directory, 'mcp.json')
  const ctx = new Context()
  ctx.reflect.provide('tools', { schemas: () => [] })
  const record = {
    serverName: 'blender', transport: 'stdio', command: 'uvx',
    args: ['--python', '3.11', '--from', 'blender-mcp==1.9.1', 'blender-mcp'],
    env: { UV_PYTHON_PREFERENCE: 'only-managed', BLENDER_PORT: '9999', DISABLE_TELEMETRY: 'true' },
    enabled: false, toolCallTimeoutMs: 90000, failOnStartupError: false,
  }
  try {
    await writeFile(path, JSON.stringify({ version: 2, servers: [], systemOverrides: [record] }))
    await ctx.plugin(McpSettingsGateway, { path })
    expect((await ctx.mcpSettings.list()).servers[0]).toMatchObject({ command: 'uvx', args: ['blender-mcp'], enabled: false, toolCallTimeoutMs: 90000 })
    const saved = JSON.parse(await readFile(path, 'utf8')) as McpSettingsDocument
    expect(saved.systemOverrides[0]).toEqual({ ...record, args: undefined, env: { BLENDER_PORT: '9999', DISABLE_TELEMETRY: 'true' } })
    expect(migrateBlenderMcpDefaults(saved)).toBe(saved)
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it('preserves custom Blender launch commands and Python selections', () => {
  for (const settings of [
    { command: 'custom-uvx', args: ['--python', '3.11', '--from', 'blender-mcp==1.9.1', 'blender-mcp'] },
    { command: 'uvx', args: ['--python', '3.12', 'blender-mcp'] },
  ]) {
    const document: McpSettingsDocument = { version: 2, servers: [], systemOverrides: [{ serverName: 'blender', enabled: true, toolCallTimeoutMs: 120000, failOnStartupError: false, ...settings }] }
    expect(migrateBlenderMcpDefaults(document)).toBe(document)
  }
})

it('mounts enabled built-ins through Cordis, disposes them on disable and restores choices after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starweave-mcp-'))
  const path = join(directory, 'mcp.json')
  const contexts: Context[] = []
  const mount = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.reflect.provide('tools', { schemas: () => [] })
    await ctx.plugin(McpSettingsGateway, { path })
    return ctx.mcpSettings
  }
  try {
    const gateway = await mount()
    expect((await gateway.list()).servers).toMatchObject([{ serverName: 'blender', enabled: false }])
    expect(lifecycle.starts).toEqual([])
    const ta = { transport: 'streamable-http' as const, serverName: 'ta-mcp-server', enabled: true, url: 'http://127.0.0.1:13360/mcp', headers: {}, toolCallTimeoutMs: 120000, failOnStartupError: false }
    await gateway.setSystem(ta)
    await vi.waitFor(() => expect(lifecycle.starts).toContain('ta-mcp-server'))
    const tune = { toolCallTimeoutMs: 120000, failOnStartupError: false }
    await gateway.updateSystem({ serverName: ta.serverName, enabled: false, ...tune })
    expect(lifecycle.stops).toContain(ta.serverName)
    expect(gateway.systemEnabled(ta.serverName)).toBe(false)
    await gateway.updateSystem({ serverName: 'blender', enabled: true, ...tune })
    await vi.waitFor(() => expect(lifecycle.starts).toContain('blender'))
    await contexts[0]!.fiber.dispose()
    const restarted = await mount()
    await restarted.setSystem(ta)
    expect(restarted.systemEnabled(ta.serverName)).toBe(false)
    expect(restarted.systemEnabled('blender')).toBe(true)
    expect(lifecycle.starts.filter(name => name === ta.serverName)).toHaveLength(1)
    await restarted.updateSystem({ serverName: ta.serverName, enabled: true, ...tune })
    await vi.waitFor(() => expect(lifecycle.starts.filter(name => name === ta.serverName)).toHaveLength(2))
    await restarted.updateSystem({ serverName: 'blender', enabled: false, ...tune })
    expect(restarted.systemEnabled('blender')).toBe(false)
    expect(lifecycle.stops).toContain('blender')
    expect(blenderMcpRecord()).toMatchObject({ enabled: false, failOnStartupError: false, command: 'uvx', args: ['blender-mcp'] })
  } finally {
    await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
    await rm(directory, { recursive: true, force: true })
  }
})

it('persists built-in connection edits, preserves hidden values and rejects invalid edits before persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starweave-mcp-edit-'))
  const path = join(directory, 'mcp.json')
  const contexts: Context[] = []
  const mount = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.reflect.provide('tools', { schemas: () => [] })
    await ctx.plugin(McpSettingsGateway, { path })
    return ctx.mcpSettings
  }
  const tuning = { serverName: 'blender', enabled: false, toolCallTimeoutMs: 120000, failOnStartupError: false }
  try {
    const gateway = await mount()
    await gateway.updateSystem({ ...tuning, transport: 'stdio', command: 'custom-uvx', args: ['custom-mcp'], cwd: 'D:\\tools', env: { SECRET: 'retained' } })
    await gateway.updateSystem({ ...tuning, transport: 'stdio', command: 'updated-uvx', args: ['updated-mcp'], cwd: 'D:\\tools' })
    const saved = await readFile(path, 'utf8')
    expect(JSON.parse(saved).systemOverrides[0].env).toEqual({ SECRET: 'retained' })
    await contexts[0]!.fiber.dispose()
    const restarted = await mount()
    expect((await restarted.list()).servers[0]).toMatchObject({ command: 'updated-uvx', args: ['updated-mcp'], cwd: 'D:\\tools', envKeys: ['SECRET'] })
    expect(JSON.stringify(await restarted.list())).not.toContain('retained')
    await expect(restarted.updateSystem({ ...tuning, transport: 'stdio', command: '' })).rejects.toThrow(/command/)
    await expect(restarted.updateSystem({ ...tuning, transport: 'streamable-http' })).rejects.toThrow(/url/)
    expect(await readFile(path, 'utf8')).toBe(saved)
    await restarted.updateSystem({ ...tuning, transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer retained' } })
    await restarted.updateSystem({ ...tuning, transport: 'streamable-http', url: 'https://example.test/new' })
    await contexts[1]!.fiber.dispose()
    const final = await mount()
    expect((await final.list()).servers[0]).toMatchObject({ transport: 'streamable-http', url: 'https://example.test/new', headerKeys: ['Authorization'], enabled: false })
    expect(JSON.stringify(await final.list())).not.toContain('Bearer retained')
  } finally {
    await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
    await rm(directory, { recursive: true, force: true })
  }
})
