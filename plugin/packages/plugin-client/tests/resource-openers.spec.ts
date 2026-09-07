import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { createResourceOpeners, resourceOpenerInject } from '../src/client/workbench/resource-openers.ts'
import { WorkbenchController } from '../src/client/workbench/session-state.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const page = { id: 'existing', url: 'https://example.com/', title: 'Example' }
const ok = <T>(value: T) => ({ ok: true as const, value })

async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  const browserCommand = vi.fn(async (..._args: unknown[]) => ok(JSON.stringify([{ id: page.id }])))
  const openFile = vi.fn(async (..._args: unknown[]) => ok(undefined))
  let removeWorkspace!: () => void
  await ctx.plugin((provider: Context) => {
    removeWorkspace = provider.provide('remote.desktopWorkspace', { browserCommand })
    provider.provide('remote.starweaveDesign', { openFile })
    provider.provide('sessions', { list: { getSnapshot: () => ({ byId: { a: { cwd: '/workspace/a' } } }) } })
  })
  const controller = new WorkbenchController()
  controller.setActiveSession('a')
  let actions!: ReturnType<typeof createResourceOpeners>
  let registered = false
  let parent!: Context
  await ctx.plugin((outer: Context) => {
    parent = outer
    outer.inject(resourceOpenerInject, inner => {
      actions = createResourceOpeners(inner, controller)
      registered = true
      return () => { registered = false }
    })
  })
  await vi.waitFor(() => expect(registered).toBe(true))
  return { ctx, parent, controller, actions, browserCommand, openFile, removeWorkspace, registered: () => registered }
}

it('requires the injected child context and opens the exact browser page in its session', async () => {
  const { parent, controller, actions, browserCommand } = await fixture()
  expect(() => createResourceOpeners(parent, controller)).toThrow('cannot get property "remote.desktopWorkspace" without inject')
  await actions.openBrowserPage('a', page)
  expect(browserCommand).toHaveBeenCalledExactlyOnceWith('a', { op: 'list' }, expect.any(AbortSignal))
  expect(controller.getSession('a')).toMatchObject({ open: true, tab: 'browser' })
  expect(controller.memory('a', 'workspace:/workspace/a').get('browser.active', null)).toBe(page.id)
  expect(controller.getSession('b').open).toBe(false)
})

it('recreates a closed browser page from the stored URL before showing it', async () => {
  const { actions, browserCommand, controller } = await fixture()
  browserCommand.mockResolvedValueOnce(ok('[]'))
  await actions.openBrowserPage('a', page)
  const command = browserCommand.mock.calls[1]![1] as { tabId: string }
  expect(command).toEqual({ op: 'create', tabId: expect.any(String), url: page.url })
  expect(command.tabId).not.toBe(page.id)
  expect(controller.memory('a', 'workspace:/workspace/a').get('browser.active', null)).toBe(command.tabId)
})

it('opens the actual canvas file through its injected remote, including explicit reload', async () => {
  const { actions, openFile, controller } = await fixture()
  await actions.openCanvasFile('a', 'design.fig', true)
  expect(openFile).toHaveBeenCalledExactlyOnceWith('a', { path: 'design.fig', reloadFromDisk: true }, expect.any(AbortSignal))
  expect(controller.getSession('a')).toMatchObject({ open: true, tab: 'canvas' })
})

it.each(['close', 'switch'] as const)('does not reveal a delayed canvas after a manual %s', async action => {
  const { actions, openFile, controller } = await fixture()
  let finish!: (value: ReturnType<typeof ok<undefined>>) => void
  openFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = actions.openCanvasFile('a', 'design.fig')
  if (action === 'close') controller.close('a')
  else controller.setActiveSession('b')
  finish(ok(undefined))
  await pending
  expect(controller.getSession('a').open).toBe(false)
  expect(controller.getSession('b').open).toBe(false)
})

it('removes dependent registration and suppresses in-flight and stale actions on service unload', async () => {
  const { actions, browserCommand, openFile, controller, removeWorkspace, registered } = await fixture()
  let finishBrowser!: (value: ReturnType<typeof ok<string>>) => void
  let finishCanvas!: (value: ReturnType<typeof ok<undefined>>) => void
  browserCommand.mockImplementationOnce(() => new Promise(resolve => { finishBrowser = resolve }))
  openFile.mockImplementationOnce(() => new Promise(resolve => { finishCanvas = resolve }))
  const browser = actions.openBrowserPage('a', page)
  const canvas = actions.openCanvasFile('a', 'design.fig')
  removeWorkspace()
  await vi.waitFor(() => expect(registered()).toBe(false))
  finishBrowser(ok('[]'))
  finishCanvas(ok(undefined))
  await Promise.all([browser, canvas])
  await actions.openBrowserPage('a', page)
  await actions.openCanvasFile('a', 'other.fig')
  expect(browserCommand).toHaveBeenCalledTimes(1)
  expect(openFile).toHaveBeenCalledTimes(1)
  expect(controller.getSession('a').open).toBe(false)
})

it('surfaces remote failures without opening details', async () => {
  const { actions, openFile, controller } = await fixture()
  openFile.mockResolvedValueOnce({ ok: false, error: { code: 'conflict', message: 'File changed on disk' } } as never)
  await expect(actions.openCanvasFile('a', 'design.fig')).rejects.toThrow('conflict: File changed on disk')
  expect(controller.getSession('a').open).toBe(false)
})
