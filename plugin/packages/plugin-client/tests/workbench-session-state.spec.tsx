// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { WorkspaceRequest } from '@run-bigpig/dsh-desktop-plugin-host/types'
import { WorkbenchController } from '../src/client/workbench/session-state.ts'
import { useSessionState } from '../src/client/workbench/session-memory.ts'

afterEach(() => { cleanup(); localStorage.clear() })

function presentation(revision: number, panel: 'canvas' | 'browser' | 'git' = 'canvas', sessionId = 'a', turn = 1) {
  return { sessionId, revision, panel, turn, cwd: '/workspace', ...(panel === 'browser' ? { tabId: 'browser-2' } : {}) }
}
function snapshot(revision: number, request: WorkspaceRequest | null, turn = 1) {
  return { epoch: 'host-1', revision, sessions: [{ sessionId: 'a', turn, request }] }
}
function controllerForTask() {
  const controller = new WorkbenchController()
  controller.setActiveSession('a')
  controller.receive(snapshot(0, null))
  return controller
}

it('switches explicit Agent targets without requiring a manual follow toggle', () => {
  const controller = controllerForTask()
  controller.receive(snapshot(1, presentation(1)))
  controller.resize('a', 960)
  controller.receive(snapshot(2, presentation(2, 'browser')))
  expect(controller.getSession('a')).toMatchObject({ tab: 'browser', width: 800, open: true })
  expect(controller.memory('a', 'workspace:/workspace').get('browser.active', null)).toBe('browser-2')
})

it('lets the foreground Agent close details without queuing a background close', () => {
  const controller = controllerForTask()
  controller.receive(snapshot(1, presentation(1, 'browser')))
  controller.receive(snapshot(2, { action: 'close', sessionId: 'a', cwd: '/workspace', turn: 1, revision: 2 }))
  expect(controller.getSession('a')).toMatchObject({ open: false, pending: null, presentation: null })

  const background = controllerForTask()
  background.receive(snapshot(1, presentation(1, 'canvas')))
  background.setActiveSession('b')
  background.receive(snapshot(2, { action: 'close', sessionId: 'a', cwd: '/workspace', turn: 1, revision: 2 }))
  expect(background.getSession('a')).toMatchObject({ open: true, pending: null })
})

it('shows Xiaohongshu in the next task after Baidu, even after the user interacted with Baidu', () => {
  const controller = controllerForTask()
  controller.receive(snapshot(1, { ...presentation(1, 'browser'), tabId: 'baidu' }))
  controller.takeOver('a')
  controller.receive(snapshot(2, null, 2))
  controller.receive(snapshot(3, { ...presentation(3, 'browser', 'a', 2), tabId: 'xiaohongshu' }, 2))
  expect(controller.getSession('a')).toMatchObject({ open: true, tab: 'browser', pending: null })
  expect(controller.memory('a', 'workspace:/workspace').get('browser.active', null)).toBe('xiaohongshu')
})

it('preserves a manual close that happens while a new-task snapshot is in flight', () => {
  const controller = controllerForTask()
  const beforeFetch = controller.captureInteractions()
  controller.close('a')
  controller.receive(snapshot(2, presentation(2, 'canvas', 'a', 2), 2), true, beforeFetch)
  expect(controller.getSession('a')).toMatchObject({ open: false, manualCollapse: true, pending: { panel: 'canvas' } })
})

it('holds a manual choice and keeps only the latest pending target', () => {
  const controller = controllerForTask()
  controller.select('a', 'git')
  controller.receive(snapshot(1, presentation(1)), false)
  controller.receive(snapshot(2, presentation(2, 'browser')), false)
  controller.select('a', 'files')
  expect(controller.getSession('a')).toMatchObject({ tab: 'files', pending: { panel: 'browser' } })
  expect(controller.memory('a', 'workspace:/workspace').get('browser.active', null)).toBeNull()
  controller.showPending('a')
  expect(controller.getSession('a')).toMatchObject({ tab: 'browser', pending: null, manualSelection: true })
})

it('respects close for the current turn, then allows the next task without opening on the boundary', () => {
  const controller = controllerForTask()
  controller.receive(snapshot(1, presentation(1)))
  controller.receive(snapshot(1, presentation(1)))
  controller.close('a')
  controller.receive(snapshot(2, presentation(2)))
  expect(controller.getSession('a').open).toBe(false)
  controller.receive(snapshot(3, null, 2))
  expect(controller.getSession('a')).toMatchObject({ open: false, manualCollapse: false, pending: null })
  controller.receive(snapshot(4, presentation(4, 'canvas', 'a', 2), 2))
  expect(controller.getSession('a')).toMatchObject({ open: true, tab: 'canvas' })
})

it('keeps background layouts unchanged even when the user later visits that session', () => {
  const controller = controllerForTask()
  controller.select('a', 'git')
  controller.setActiveSession('b')
  controller.receive(snapshot(1, presentation(1)))
  expect(controller.getSession('a')).toMatchObject({ open: true, tab: 'git', pending: { panel: 'canvas' } })
  controller.setActiveSession('a')
  expect(controller.getSession('a').tab).toBe('git')
  controller.showPending('a')
  expect(controller.getSession('a').tab).toBe('canvas')
  expect(controller.getSession('b').open).toBe(false)
})

it('does not replay stale requests after refresh or host restart and retains same-task close', () => {
  const controller = controllerForTask()
  controller.receive(snapshot(1, presentation(1)))
  controller.close('a')
  controller.receive(snapshot(2, presentation(2)))
  const restored = new WorkbenchController()
  restored.setActiveSession('a')
  restored.receive(snapshot(2, presentation(2)))
  expect(restored.getSession('a')).toMatchObject({ open: false, manualCollapse: true, pending: null })
  restored.receive(snapshot(3, presentation(3)))
  expect(restored.getSession('a').open).toBe(false)
  restored.receive({ ...snapshot(0, null), epoch: 'host-2' })
  expect(restored.getSession('a').open).toBe(false)
})

it('ignores delayed snapshots and does not switch while the document or native browser has focus elsewhere', () => {
  const controller = controllerForTask()
  controller.receive(snapshot(2, presentation(2, 'browser')), false)
  controller.receive(snapshot(1, presentation(1)))
  expect(controller.getSession('a')).toMatchObject({ open: false, pending: { panel: 'browser' } })
  controller.follow('a', true)
  expect(controller.getSession('a')).toMatchObject({ open: true, tab: 'browser', pending: null })
})

it('pauses automatic switching after interacting inside the current resource', () => {
  const controller = controllerForTask()
  controller.receive(snapshot(1, presentation(1)))
  controller.takeOver('a')
  controller.receive(snapshot(2, presentation(2)))
  expect(controller.getSession('a')).toMatchObject({ tab: 'canvas', manualSelection: true })
  controller.receive(snapshot(3, presentation(3, 'browser')))
  expect(controller.getSession('a')).toMatchObject({ tab: 'browser', manualSelection: false })
})

it('retains each session draft across the actual details unmount boundary', () => {
  const controller = new WorkbenchController()
  function Draft({ sessionId }: { sessionId: string }) {
    const [value, setValue] = useSessionState(controller.memory(sessionId, 'git'), 'message', '')
    return <input aria-label="Commit" value={value} onChange={event => { setValue(event.target.value) }} />
  }
  const view = render(<Draft key="a" sessionId="a" />)
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'Session A commit' } })
  view.rerender(<Draft key="b" sessionId="b" />)
  expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('')
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'Session B commit' } })
  view.rerender(<Draft key="a" sessionId="a" />)
  expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('Session A commit')
  view.unmount()
  act(() => { controller.remove('a') })
  const restored = render(<Draft sessionId="a" />)
  expect((restored.getByRole('textbox') as HTMLInputElement).value).toBe('')
  expect(controller.memory('b', 'git').get('message', '')).toBe('Session B commit')
})

it('dismisses a presentation cycle, allows a new explicit step, and never replays the dismissed step', () => {
  const controller = controllerForTask()
  controller.receive(snapshot(1, { ...presentation(1), path: 'first.fig', presentation: 'draw-first' }))
  controller.close('a')
  controller.receive(snapshot(2, { ...presentation(2), path: 'first.fig', presentation: 'draw-first' }))
  expect(controller.getSession('a').open).toBe(false)
  controller.receive(snapshot(3, { ...presentation(3), path: 'first.fig', presentation: 'edit-first' }))
  expect(controller.getSession('a').open).toBe(true)
  controller.close('a')
  controller.receive(snapshot(4, { ...presentation(4), path: 'first.fig', presentation: 'draw-first' }))
  expect(controller.getSession('a').open).toBe(false)
  controller.receive(snapshot(5, { ...presentation(5), path: 'second.fig' }))
  expect(controller.getSession('a').open).toBe(true)
})

it('does not open a file after the user closed details or changed sessions while it was loading', () => {
  const controller = controllerForTask()
  const interactions = controller.captureInteractions()
  controller.close('a')
  controller.openCanvasFile('a', interactions)
  expect(controller.getSession('a').open).toBe(false)
  controller.setActiveSession('b')
  controller.openCanvasFile('a', controller.captureInteractions())
  expect(controller.getSession('a').open).toBe(false)
})
