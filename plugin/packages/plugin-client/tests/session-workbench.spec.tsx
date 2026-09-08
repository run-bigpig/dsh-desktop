// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HARNESS_FILE_REFERENCE_SOURCE,
  WorkbenchController,
  WorkbenchLauncher,
  WorkbenchDrawer,
  type WorkbenchDrawerProps,
  WORKSPACE_DRAG_MIME,
  WorkspaceReferenceDropDock,
  type WorkbenchLauncherProps,
  workspaceFileReferenceOf,
  type WorkspaceReferenceDropDockProps,
} from '../src/client/workbench/SessionWorkbench.tsx'
import { workbenchEn, workbenchZh } from '../src/client/locales.ts'

afterEach(() => { localStorage.clear(); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function translate(key: keyof typeof workbenchEn): string {
  return workbenchEn[key]
}

describe('session workbench file references', () => {
  it('provides localized workbench titles', () => {
    expect(workbenchZh.title).toBe('工作台')
    expect(workbenchEn.title).toBe('Workbench')
  })

  it('renders a session-header utility that toggles the shared workbench', () => {
    const controller = new WorkbenchController()
    const props = {
      controller,
      sessionId: 'session-1',
      t: translate,
    } as unknown as WorkbenchLauncherProps
    const view = render(<WorkbenchLauncher {...props} />)
    const button = view.getByRole('button', { name: workbenchEn.open })

    fireEvent.click(button)

    expect(controller.getSession('session-1').open).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(view.getByRole('button', { name: workbenchEn.close })).toBe(button)
  })

  it('opens files from the manual launcher even when an Agent target is pending', () => {
    const controller = new WorkbenchController()
    controller.setActiveSession('session-1')
    controller.select('session-1', 'browser')
    controller.close('session-1')
    controller.request({ sessionId: 'session-1', panel: 'browser', tabId: 'xiaohongshu', turn: 1, revision: 1, cwd: '/workspace' }, false)
    const view = render(<WorkbenchLauncher {...{ controller, sessionId: 'session-1', t: translate } as unknown as WorkbenchLauncherProps} />)
    expect(controller.getSession('session-1').open).toBe(false)
    fireEvent.click(view.getByRole('button', { name: workbenchEn.open }))
    expect(controller.getSession('session-1')).toMatchObject({ open: true, tab: 'files', pending: { panel: 'browser' } })
    expect(controller.memory('session-1', 'workspace:/workspace').get('browser.active', null)).toBeNull()
  })

  it('uses the official Harness reference source and file mention grammar', () => {
    expect(workspaceFileReferenceOf('docs/design notes.md')).toEqual({
      source: HARNESS_FILE_REFERENCE_SOURCE,
      ref: '@"docs/design notes.md"',
      label: 'design notes.md',
      appearance: 'file',
      clipboardText: '@"docs/design notes.md"',
    })
  })

  it('drops a workspace file at the current draft end with the live revision', () => {
    const controller = new WorkbenchController()
    const insertFile = vi.fn().mockReturnValue(true)
    controller.startDrag({ sessionId: 'session-1', path: 'src/index.ts', name: 'index.ts' })
    const state = {
      draft: 'review ',
      imageIds: [],
      draftRev: 9,
      phase: 'plain',
      occurrences: [],
      queue: [],
    }
    const props = {
      sessionId: 'session-1',
      useInput: (selector: (value: typeof state) => unknown) => selector(state),
      controller,
      insertFile,
      t: translate,
    } as unknown as WorkspaceReferenceDropDockProps
    const view = render(<WorkspaceReferenceDropDock {...props} />)
    const dropTarget = view.getByText('src/index.ts').closest('div')

    fireEvent.drop(dropTarget as HTMLDivElement, {
      dataTransfer: { types: [WORKSPACE_DRAG_MIME] },
    })

    expect(insertFile).toHaveBeenCalledWith('src/index.ts', {
      start: 7,
      end: 7,
      draftRev: 9,
    })
    expect(controller.getDrag()).toBeNull()
  })
})

vi.mock('../src/client/workbench/WorkspaceWorkbench.tsx', () => ({ WorkspaceWorkbench: () => <div>Document preview</div> }))

it('opens at 520px, remembers manual width between 360px and 800px and hides on a blank session', () => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1800 } as DOMRect)
  const controller = new WorkbenchController()
  controller.toggle('session-1')
  let state = { current: 'session-1', byId: { 'session-1': { blank: false, cwd: '/workspace' } } }
  const props = {
    controller,
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    useSessions: (selector: (value: typeof state) => unknown) => selector(state),
    gitActions: () => ({ snapshot: () => new Promise(() => {}) }),
    t: translate,
  } as unknown as WorkbenchDrawerProps
  const frame = () => <div data-testid="frame" style={{ gridTemplateColumns: '280px minmax(0, 1fr) 360px' }}><div /><div /><div data-slot="details"><WorkbenchDrawer {...props} /></div><div data-shell-overlay /></div>
  const view = render(frame())
  const root = view.getByTestId('frame')
  expect(root.style.getPropertyValue('--starweave-workbench-width')).toBe('520px')
  expect(view.getByRole('complementary').closest('[data-slot="details"]')).not.toBeNull()
  const separator = view.getByRole('separator', { name: workbenchEn.resizeWorkbench })
  expect(separator.getAttribute('aria-valuemax')).toBe('800')
  fireEvent.keyDown(separator, { key: 'ArrowLeft' })
  expect(root.style.getPropertyValue('--starweave-workbench-width')).toBe('560px')
  for (let step = 0; step < 7; step++) fireEvent.keyDown(separator, { key: 'ArrowLeft' })
  expect(root.style.getPropertyValue('--starweave-workbench-width')).toBe('800px')
  view.unmount()
  expect(root.style.getPropertyValue('--starweave-workbench-width')).toBe('')
  const reopened = render(frame())
  expect(reopened.getByTestId('frame').style.getPropertyValue('--starweave-workbench-width')).toBe('800px')
  fireEvent.doubleClick(reopened.getByRole('separator'))
  expect(reopened.getByTestId('frame').style.getPropertyValue('--starweave-workbench-width')).toBe('520px')
  state = { ...state, byId: { 'session-1': { blank: true, cwd: '/workspace' } } }
  reopened.rerender(frame())
  expect(reopened.queryByRole('complementary')).toBeNull()
  localStorage.clear()
})
