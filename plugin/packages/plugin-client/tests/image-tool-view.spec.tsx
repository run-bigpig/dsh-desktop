// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ImageToolView, type ImageToolViewProps } from '../src/client/ImageToolView.tsx'
import { workbenchEn } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

function translate(key: keyof typeof workbenchEn, params?: Record<string, string | number>): string {
  return Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    workbenchEn[key],
  )
}

describe('image tool view', () => {
  it('renders an image-development loading state for running render tools', () => {
    const props = {
      toolName: 'image_generate',
      block: {
        id: 'call-running', name: 'image_generate', argsRaw: '{"prompt":"A quiet harbor at blue hour"}',
      },
      sessionId: 'session-a',
      useProjection: () => undefined,
      loadImage: vi.fn(),
      controller: { openImage: vi.fn() },
      t: translate,
    } as unknown as ImageToolViewProps
    const view = render(<ImageToolView {...props} />)

    expect(view.getByRole('status').textContent).toContain('Developing image')
    expect(view.getByRole('status').textContent).toContain('A quiet harbor at blue hour')
    expect(view.container.querySelector('[data-phase="running"][data-loading="true"]')).toBeTruthy()
    expect(view.container.querySelector('svg[class*="chevron"]')).toBeTruthy()
  })

  it('renders settled image task metadata, dimensions, and the generated image', async () => {
    const block = {
      kind: 'tool-result', seq: 1, time: Date.now(), callId: 'call-a', callTime: Date.now() - 100,
      call: { name: 'image_generate', argsRaw: '{"prompt":"Draw a lighthouse"}' },
      content: [
        { type: 'text', text: '{"taskId":"task-a","revision":2,"currentVersionId":"version-a","model":{"provider":"google","model":"gemini-image"}}' },
        { type: 'image', attachment: { attachmentId: AttachmentId('attachment-a'), mediaType: 'image/png', bytes: 68, width: 1024, height: 1024, name: 'generated.png' } },
      ],
      isError: false, callView: null, resultView: null, subCalls: [],
    }
    const props = {
      toolName: 'image_generate',
      block,
      sessionId: 'session-a',
      useProjection: () => undefined,
      loadImage: vi.fn().mockResolvedValue('data:image/png;base64,AA=='),
      controller: { openImage: vi.fn() },
      t: translate,
    } as unknown as ImageToolViewProps
    const view = render(<ImageToolView {...props} />)

    expect(view.getByText('Generate image')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /Generate image/ }))
    expect(view.getByText('task-a')).toBeTruthy()
    expect(view.getByText('1024 × 1024')).toBeTruthy()
    expect(view.getByText('google / gemini-image')).toBeTruthy()
    expect(view.queryByText('Revision')).toBeNull()
    expect(view.queryByText('Version')).toBeNull()
    expect(view.queryByRole('button', { name: /Use this version|Restore original/ })).toBeNull()
    expect(await view.findByRole('img', { name: 'generated.png' })).toBeTruthy()
  })

  it('keeps the edit card mounted when a running task settles with an image', async () => {
    const common = {
      toolName: 'image_edit',
      sessionId: 'session-a',
      useProjection: () => undefined,
      loadImage: vi.fn().mockResolvedValue('data:image/jpeg;base64,AA=='),
      controller: { openImage: vi.fn() },
      t: translate,
    }
    const view = render(<ImageToolView {...({
      ...common,
      block: { id: 'call-edit', name: 'image_edit', argsRaw: '{"instruction":"Add a hat"}' },
    } as unknown as ImageToolViewProps)} />)

    expect(view.container.querySelector('[data-phase="running"]')).toBeTruthy()
    view.rerender(<ImageToolView {...({
      ...common,
      block: {
        kind: 'tool-result', seq: 2, time: Date.now(), callId: 'call-edit', callTime: Date.now() - 100,
        call: { name: 'image_edit', argsRaw: '{"instruction":"Add a hat"}' },
        content: [
          { type: 'text', text: '{"taskId":"task-edit","operation":"edit"}' },
          { type: 'image', attachment: { attachmentId: AttachmentId('attachment-edit'), mediaType: 'image/jpeg', bytes: 68, width: 864, height: 1248, name: 'edited.jpg' } },
        ],
        isError: false, callView: null, resultView: null, subCalls: [],
      },
    } as unknown as ImageToolViewProps)} />)

    expect(view.container.querySelector('[data-phase="ready"]')).toBeTruthy()
    expect(view.getByText('Edit image')).toBeTruthy()
    expect(await view.findByRole('img', { name: 'edited.jpg' })).toBeTruthy()
  })

  it('shows batch progress and all successful images in one card', async () => {
    const running = {
      toolName: 'image_generate',
      block: {
        id: 'call-running', name: 'image_generate', argsRaw: '{"prompts":["A red kite","A blue sailboat"]}',
      },
      sessionId: 'session-a',
      useProjection: () => undefined,
      loadImage: vi.fn(),
      controller: { openImage: vi.fn() },
      t: translate,
    } as unknown as ImageToolViewProps
    const loadingView = render(<ImageToolView {...running} />)
    expect(loadingView.getByRole('status').textContent).toContain('Generating 2 images')
    loadingView.unmount()

    const block = {
      kind: 'tool-result', seq: 2, time: Date.now(), callId: 'call-b', callTime: Date.now() - 100,
      call: { name: 'image_generate', argsRaw: '{"prompts":["A red kite","A blue sailboat","A green hill"]}' },
      content: [
        { type: 'text', text: '{"status":"partial","requested":3,"completed":2,"failed":1,"results":[{"prompt":"A red kite","taskId":"task-a","model":{"provider":"google","model":"gemini-image"}},{"prompt":"A blue sailboat","taskId":"task-b","model":{"provider":"google","model":"gemini-image"}}],"failures":[{"prompt":"A green hill","error":"provider unavailable"}]}' },
        { type: 'image', attachment: { attachmentId: AttachmentId('attachment-a'), mediaType: 'image/png', bytes: 68, width: 1024, height: 1024, name: 'kite.png' } },
        { type: 'image', attachment: { attachmentId: AttachmentId('attachment-b'), mediaType: 'image/png', bytes: 68, width: 1024, height: 1024, name: 'sailboat.png' } },
      ],
      isError: false, callView: null, resultView: null, subCalls: [],
    }
    const props = {
      ...running,
      block,
      loadImage: vi.fn().mockResolvedValue('data:image/png;base64,AA=='),
    } as unknown as ImageToolViewProps
    const view = render(<ImageToolView {...props} />)

    expect(view.getByText('Generated 2; 1 failed')).toBeTruthy()
    expect(await view.findByRole('img', { name: 'kite.png' })).toBeTruthy()
    expect(await view.findByRole('img', { name: 'sailboat.png' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /Generate image/ }))
    expect(view.getByText('task-a, task-b')).toBeTruthy()
    expect(view.getByText('1024 × 1024 · 2')).toBeTruthy()
    expect(view.getByText(/A green hill: provider unavailable/)).toBeTruthy()
  })
})
