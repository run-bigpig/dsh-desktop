import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceGateway } from '../src/workspace/index.ts'
import { desktopRequest } from '../src/desktop/index.ts'

vi.mock('../src/desktop/index.ts', () => ({ desktopRequest: vi.fn(async () => []) }))
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())); vi.clearAllMocks() })

async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  const tools = new Map<string, { execute: (args: any, exec: any) => Promise<string> }>()
  ctx.reflect.provide('tools', { register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  ctx.reflect.provide('attachments', { saveImage: vi.fn(async () => ({ id: 'screenshot' })) })
  ctx.reflect.provide('sessions', {})
  await ctx.plugin(WorkspaceGateway)
  const agent = { session: { id: 'a', header: { cwd: '/workspace' } } } as Agent
  const exec = { agent, signal: new AbortController().signal }
  return { ctx, gateway: ctx.desktopWorkspace, agent, exec, tool: (name: string) => tools.get(name)! }
}

it('keeps browser operations private until explicitly asked to reveal the resulting tab', async () => {
  const { gateway, tool, exec } = await fixture()
  const browser = tool('workspace_browser')
  await browser.execute({ action: 'create', url: 'https://www.baidu.com/' }, exec)
  await browser.execute({ action: 'cdp', tabId: 'baidu', method: 'DOM.getDocument' }, exec)
  expect(gateway.pendingRequests().sessions).toEqual([])
  await browser.execute({ action: 'create', url: 'https://www.xiaohongshu.com/', reveal: true }, exec)
  const request = gateway.pendingRequests().sessions[0]!.request!
  const command = JSON.parse(String(vi.mocked(desktopRequest).mock.calls.at(-1)![1]!.body))
  expect(request).toMatchObject({ sessionId: 'a', panel: 'browser', tabId: command.tabId })
  expect(command.url).toBe('https://www.xiaohongshu.com/')
})

it('uses real turn boundaries, coalesces presentation, and does not treat ordinary activity as a new task', async () => {
  const { ctx, gateway, agent } = await fixture()
  ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } } as never)
  gateway.request(agent, 'canvas')
  gateway.request(agent, 'browser', 'target')
  expect(gateway.pendingRequests().sessions).toMatchObject([{ turn: 1, request: { panel: 'browser', tabId: 'target', turn: 1 } }])
  const revision = gateway.pendingRequests().revision
  ctx.emit('session/event', agent.session, { type: 'user/message' } as never)
  expect(gateway.pendingRequests().revision).toBe(revision)
  ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } } as never)
  expect(gateway.pendingRequests().sessions).toEqual([{ sessionId: 'a', turn: 2, request: null }])
})

it('lets the Agent close the current session panel without destroying its resources', async () => {
  const { gateway, tool, exec } = await fixture()
  await expect(tool('close_workspace_panel').execute({}, exec)).resolves.toBe('已请求关闭当前会话侧边栏。')
  expect(gateway.pendingRequests().sessions).toEqual([{
    sessionId: 'a',
    turn: 0,
    request: expect.objectContaining({ action: 'close', sessionId: 'a', turn: 0 }),
  }])
  expect(desktopRequest).not.toHaveBeenCalled()
})

it('rejects obsolete browser close calls before reaching the desktop gateway', async () => {
  const { gateway, tool, exec } = await fixture()
  await expect(tool('workspace_browser').execute({ action: 'close', tabId: 'stale-tab' }, exec)).rejects.toThrow()
  expect(desktopRequest).not.toHaveBeenCalled()
  expect(gateway.pendingRequests().sessions).toEqual([])
})

it('keeps repeated panel dismissal within the owning session', async () => {
  const { gateway, tool, exec, agent } = await fixture()
  const other = { session: { id: 'b', header: { cwd: '/other' } } } as Agent
  gateway.request(other, 'browser', 'other-tab')
  const otherRequest = gateway.pendingRequests().sessions.find(session => session.sessionId === 'b')
  gateway.request(agent, 'browser', 'current-tab')
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(tool('close_workspace_panel').execute({}, exec)).resolves.toBe('已请求关闭当前会话侧边栏。')
    expect(gateway.pendingRequests().sessions.find(session => session.sessionId === 'a')?.request).toMatchObject({ action: 'close', sessionId: 'a' })
    expect(gateway.pendingRequests().sessions.find(session => session.sessionId === 'b')).toEqual(otherRequest)
  }
  expect(desktopRequest).not.toHaveBeenCalled()
})

it('does not dismiss the panel for a cancelled close request', async () => {
  const { gateway, tool, exec, agent } = await fixture()
  gateway.request(agent, 'browser', 'current-tab')
  const before = gateway.pendingRequests()
  const abort = new AbortController()
  abort.abort()
  await expect(tool('close_workspace_panel').execute({}, { ...exec, signal: abort.signal })).rejects.toThrow()
  expect(gateway.pendingRequests()).toEqual(before)
  expect(desktopRequest).not.toHaveBeenCalled()
})

it('rejects foreign browser targets and failed or cancelled navigation without revealing', async () => {
  const { gateway, tool, exec } = await fixture()
  vi.mocked(desktopRequest).mockResolvedValueOnce([{ id: 'owned' }])
  await expect(tool('open_workspace_panel').execute({ panel: 'browser', tabId: 'foreign' }, exec)).rejects.toThrow('真实浏览器')
  vi.mocked(desktopRequest).mockRejectedValueOnce(new Error('navigation failed'))
  await expect(tool('workspace_browser').execute({ action: 'navigate', tabId: 'owned', url: 'https://example.com', reveal: true }, exec)).rejects.toThrow('navigation failed')
  const abort = new AbortController()
  abort.abort()
  await expect(tool('workspace_browser').execute({ action: 'navigate', tabId: 'owned', url: 'https://example.com', reveal: true }, { ...exec, signal: abort.signal })).rejects.toThrow()
  expect(gateway.pendingRequests().sessions).toEqual([])
})
