// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserWorkbench, nextBrowserLayoutSequence } from '../src/client/workbench/BrowserWorkbench.tsx'
import { SessionMemory } from '../src/client/workbench/session-memory.ts'
import type { WorkbenchDrawerProps } from '../src/client/workbench/SessionWorkbench.tsx'
import { workbenchZh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('lets the original desktop page resume presentation after a newer client disconnects', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-07T12:00:00Z'))
  const first = nextBrowserLayoutSequence()
  vi.setSystemTime(new Date('2026-09-07T12:10:00Z'))
  vi.resetModules()
  const newerClient = await import('../src/client/workbench/BrowserWorkbench.tsx')
  const lastTemporaryLayout = newerClient.nextBrowserLayoutSequence()
  expect(lastTemporaryLayout).toBeGreaterThan(first)
  vi.advanceTimersByTime(1000)
  const resumed = nextBrowserLayoutSequence()
  expect(resumed).toBeGreaterThan(lastTemporaryLayout)
  expect(nextBrowserLayoutSequence()).toBeGreaterThan(resumed)
})

it('uses browser copy while creating a page instead of directory loading copy', async () => {
  let finish!: (value: string) => void
  const pending = new Promise<string>(resolve => { finish = resolve })
  const command = vi.fn((request: { op: string }) => request.op === 'create' ? pending : Promise.resolve('[]'))
  const t = ((key: keyof typeof workbenchZh) => workbenchZh[key]) as WorkbenchDrawerProps['t']
  render(<BrowserWorkbench memory={new SessionMemory()} visible command={command} t={t} />)
  expect(screen.getByRole('button', { name: '刷新网页' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '新建标签页' }))
  expect(screen.getByText('正在加载网页…')).toBeTruthy()
  expect(screen.queryByText('正在读取目录…')).toBeNull()
  await act(async () => { finish('{"id":"temporary"}'); await pending })
})

it('switches the native page and address to Xiaohongshu and ignores an older Baidu-only poll', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 } as DOMRect)
  const memory = new SessionMemory()
  const baidu = { id: 'baidu', title: '百度', url: 'https://www.baidu.com/' }
  const xhs = { id: 'xiaohongshu', title: '小红书', url: 'https://www.xiaohongshu.com/' }
  memory.set('browser.tabs', [baidu, xhs], [])
  memory.set('browser.active', 'baidu', null)
  let finish!: (value: string) => void
  const oldList = new Promise<string>(resolve => { finish = resolve })
  const command = vi.fn((request: { op: string }) => request.op === 'list' ? oldList : Promise.resolve('true'))
  const t = ((key: keyof typeof workbenchZh) => workbenchZh[key]) as WorkbenchDrawerProps['t']
  const view = render(<BrowserWorkbench memory={memory} visible command={command} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '切换网页' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '小红书' }))
  await act(async () => { finish(JSON.stringify([baidu])); await oldList })
  expect(memory.get('browser.active', null)).toBe('xiaohongshu')
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(xhs.url)
  expect(command.mock.calls.map(([request]) => request).filter((request: any) => request.op === 'layout' && request.visible).at(-1)).toMatchObject({ tabId: xhs.id })
  fireEvent.click(screen.getByRole('button', { name: '切换网页' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '百度' }))
  expect(memory.get('browser.active', null)).toBe('baidu')
  await act(async () => { memory.set('browser.active', xhs.id, null) })
  expect(memory.get('browser.active', null)).toBe('xiaohongshu')
  expect(command.mock.calls.map(([request]) => request).filter((request: any) => request.op === 'layout' && request.visible).at(-1)).toMatchObject({ tabId: xhs.id })
  view.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
