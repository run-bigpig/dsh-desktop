// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkspacePreview, tabFromFile, type WorkspacePreviewCopy,
} from '../src/client/WorkspacePreview.tsx'

afterEach(() => { cleanup() })

const copy: WorkspacePreviewCopy = {
  preview: 'Preview',
  closePreview: 'Close preview',
  noPreview: 'No file is open',
  noPreviewHint: 'Choose a file to preview it.',
  close: 'Close tab',
  closeOthers: 'Close other tabs',
  closeAll: 'Close all tabs',
  dirtyCloseTitle: 'Discard unsaved edits?',
  dirtyCloseHint: 'Unsaved content will be lost.',
  discard: 'Discard changes',
  cancel: 'Cancel',
  refresh: 'Reload file',
  updated: 'Updated on disk',
  source: 'Source',
  rendered: 'Preview',
  split: 'Split',
  save: 'Save',
  download: 'Download',
  loading: 'Reading file…',
  loadFailed: 'File preview failed',
  truncated: 'File truncated',
  unsupported: 'Unsupported format',
  unsupportedHint: 'Open it locally.',
  moreTabs: 'More open tabs',
  saveFailed: 'Save failed',
}

describe('workspace preview UI', () => {
  it('uses a scroll viewport and an official overflow menu instead of URL opening', () => {
    const tabs = [
      tabFromFile({ path: 'src/alpha.ts', content: 'alpha', encoding: 'utf8', mediaType: 'text/plain', size: 5, mtime: 1, truncated: false }),
      tabFromFile({ path: 'src/beta.ts', content: 'beta', encoding: 'utf8', mediaType: 'text/plain', size: 4, mtime: 2, truncated: false }),
      tabFromFile({ path: 'src/gamma.ts', content: 'gamma', encoding: 'utf8', mediaType: 'text/plain', size: 5, mtime: 3, truncated: false }),
    ]
    const onActivate = vi.fn()
    const view = render(<WorkspacePreview
      tabs={tabs}
      activeId={tabs[0].id}
      copy={copy}
      onActivate={onActivate}
      onClose={vi.fn()}
      onChange={vi.fn()}
      onRefresh={vi.fn()}
      onSave={vi.fn().mockResolvedValue(undefined)}
    />)

    expect(view.getByRole('region', { name: 'alpha.ts' }).textContent).toContain('alpha')
    expect(view.queryByText('Open URL')).toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'More open tabs' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'beta.ts' }))

    expect(onActivate).toHaveBeenCalledWith(tabs[1].id)
  })

  it('uses the Ant Design image preview for workspace images', async () => {
    const tab = tabFromFile({
      path: 'assets/preview.png',
      content: 'data:image/png;base64,iVBORw0KGgo=',
      encoding: 'base64',
      mediaType: 'image/png',
      size: 68,
      mtime: 1,
      truncated: false,
    })
    const view = render(<WorkspacePreview
      tabs={[tab]}
      activeId={tab.id}
      copy={copy}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onChange={vi.fn()}
      onRefresh={vi.fn()}
      onSave={vi.fn().mockResolvedValue(undefined)}
    />)

    fireEvent.click(view.getByRole('button', { name: 'preview.png' }))
    expect(view.getByRole('dialog', { name: 'preview.png' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Close preview' }))
    await waitFor(() => { expect(view.queryByRole('dialog', { name: 'preview.png' })).toBeNull() })
  })
})
