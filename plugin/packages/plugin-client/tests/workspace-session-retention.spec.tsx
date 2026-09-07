// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceWorkbench } from '../src/client/workbench/WorkspaceWorkbench.tsx'
import { WorkbenchController } from '../src/client/workbench/session-state.ts'
import { workbenchEn } from '../src/client/locales.ts'

afterEach(() => { cleanup(); localStorage.clear() })

it('retains unsaved file content across session remounts without writing another session', async () => {
  const controller = new WorkbenchController()
  const write = vi.fn(async () => ({ path: 'draft.txt', mtime: 2 }))
  const read = vi.fn(async () => ({ path: 'draft.txt', content: 'disk', encoding: 'utf8' as const, mediaType: 'text/plain', size: 4, mtime: 1, truncated: false }))
  const props = {
    controller, activePanel: 'files' as const, visible: true,
    listDirectory: async () => ({ path: '', rootName: 'workspace', entries: [{ path: 'draft.txt', name: 'draft.txt', kind: 'file' as const }] }),
    search: async () => ({ query: '', hits: [], truncated: false }),
    readFile: read, writeFile: write, gitSnapshot: null,
    onGitSnapshot: vi.fn(), onPreviewVisibility: vi.fn(), t: (key: keyof typeof workbenchEn) => workbenchEn[key],
  }
  const view = render(<WorkspaceWorkbench key="a" {...props} sessionId="a" scope="a:/workspace" />)
  fireEvent.click(await view.findByRole('treeitem'))
  await waitFor(() => expect(view.getAllByRole('textbox').some(input => (input as HTMLTextAreaElement).value === 'disk')).toBe(true))
  fireEvent.change(view.getAllByRole('textbox').find(input => input.tagName === 'TEXTAREA')!, { target: { value: 'draft for A' } })
  view.rerender(<WorkspaceWorkbench key="b" {...props} sessionId="b" scope="b:/workspace" />)
  expect(view.queryByDisplayValue('draft for A')).toBeNull()
  fireEvent.click(await view.findByRole('treeitem'))
  await view.findByDisplayValue('disk')
  view.rerender(<WorkspaceWorkbench key="a" {...props} sessionId="a" scope="a:/workspace" />)
  expect(await view.findByDisplayValue('draft for A')).toBeTruthy()
  expect(write).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: workbenchEn.saveFile }))
  await waitFor(() => expect(write).toHaveBeenCalledWith({ path: 'draft.txt', content: 'draft for A', baseMtime: 1 }, expect.any(AbortSignal)))
})

it('opens an explicitly requested file through the same session memory used by the details panel', async () => {
  const controller = new WorkbenchController()
  controller.setActiveSession('a')
  controller.request({ sessionId: 'a', panel: 'files', path: 'result.txt', cwd: '/workspace', turn: 1, revision: 1 })
  const read = vi.fn(async (path: string) => ({ path, content: 'requested result', encoding: 'utf8' as const, mediaType: 'text/plain', size: 16, mtime: 1, truncated: false }))
  const view = render(<WorkspaceWorkbench sessionId="a" scope="a:/workspace" activePanel="files" visible controller={controller}
    listDirectory={async () => ({ rootName: 'workspace', directory: '', entries: [] })}
    search={async () => ({ query: '', hits: [], truncated: false })} readFile={read}
    writeFile={vi.fn()} gitSnapshot={null} onGitSnapshot={vi.fn()} onPreviewVisibility={vi.fn()}
    t={key => workbenchEn[key]} />)
  expect(await view.findByDisplayValue('requested result')).toBeTruthy()
  expect(read).toHaveBeenCalledWith('result.txt', expect.any(AbortSignal))
  expect(controller.memory('a', 'workspace:a:/workspace').get('requestedFile', null)).toBeNull()
  expect(controller.memory('b', 'workspace:b:/workspace').get('requestedFile', null)).toBeNull()
})
