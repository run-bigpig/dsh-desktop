// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { parseCsv, previewKind, tabFromFile } from '../src/client/WorkspacePreview.tsx'

describe('workspace preview', () => {
  it('routes the supported AionUi preview formats without claiming Office rendering', () => {
    expect(previewKind('README.md')).toBe('markdown')
    expect(previewKind('report.csv')).toBe('csv')
    expect(previewKind('photo.webp')).toBe('image')
    expect(previewKind('manual.pdf')).toBe('pdf')
    expect(previewKind('sheet.xlsx')).toBe('office')
    expect(previewKind('src/index.ts')).toBe('code')
  })

  it('parses quoted CSV cells', () => {
    expect(parseCsv('name,note\nAlice,"a,b"\n')).toEqual([
      ['name', 'note'],
      ['Alice', 'a,b'],
    ])
  })

  it('creates a clean editable tab from the host snapshot', () => {
    expect(tabFromFile({
      path: 'README.md', content: '# Hello', encoding: 'utf8', mediaType: 'text/markdown',
      size: 7, mtime: 42, truncated: false,
    })).toMatchObject({ id: 'file:README.md', kind: 'markdown', dirty: false, mtime: 42 })
  })
})
