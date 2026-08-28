// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HARNESS_FILE_REFERENCE_SOURCE,
  WorkbenchController,
  WorkbenchLauncher,
  WORKSPACE_DRAG_MIME,
  WorkspaceReferenceDropDock,
  type WorkbenchLauncherProps,
  workspaceFileReferenceOf,
  type WorkspaceReferenceDropDockProps,
} from '../src/client/workbench/SessionWorkbench.tsx'
import { workbenchEn, workbenchZh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

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
      t: translate,
    } as unknown as WorkbenchLauncherProps
    const view = render(<WorkbenchLauncher {...props} />)
    const button = view.getByRole('button', { name: workbenchEn.open })

    fireEvent.click(button)

    expect(controller.getOpen()).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(view.getByRole('button', { name: workbenchEn.close })).toBe(button)
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
