// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  ImageStudioInputBridge,
  type ImageStudioInputBridgeProps,
  MessageImageGallery,
  type MessageImageGalleryProps,
} from '../src/client/MessageImageGallery.tsx'
import { WorkbenchController } from '../src/client/SessionWorkbench.tsx'
import { workbenchEn } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

function translate(key: keyof typeof workbenchEn, params?: Readonly<Record<string, unknown>>): string {
  let value = workbenchEn[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}

describe('message image gallery', () => {
  it('opens Image Studio only from the image edit control', async () => {
    const controller = new WorkbenchController()
    const attachment = {
      attachmentId: AttachmentId('attachment-a'),
      mediaType: 'image/png' as const,
      bytes: 68,
      width: 320,
      height: 200,
      name: 'pixel.png',
    }
    const props = {
      sessionId: 'session-a',
      images: [{ attachment }],
      align: 'start',
      loadImage: async () => 'data:image/png;base64,iVBORw0KGgo=',
      useProjection: () => undefined,
      controller,
      t: translate,
    } as unknown as MessageImageGalleryProps
    const view = render(<MessageImageGallery {...props} />)

    expect(controller.getImage()).toBeNull()
    const edit = await view.findByRole('button', { name: 'Edit image pixel.png' })
    await waitFor(() => { expect((edit as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(edit)
    expect(controller.getImage()).toMatchObject({ sessionId: 'session-a', label: 'pixel.png' })
    expect(controller.getOpen()).toBe(true)
  })

  it('uses the Ant Design image preview for message images', async () => {
    const attachment = {
      attachmentId: AttachmentId('attachment-preview'),
      mediaType: 'image/png' as const,
      bytes: 68,
      width: 320,
      height: 200,
      name: 'preview.png',
    }
    const props = {
      sessionId: 'session-a',
      images: [{ attachment }],
      align: 'start',
      loadImage: async () => 'data:image/png;base64,iVBORw0KGgo=',
      useProjection: () => undefined,
      controller: new WorkbenchController(),
      t: translate,
    } as unknown as MessageImageGalleryProps
    const view = render(<MessageImageGallery {...props} />)
    const open = await view.findByRole('button', { name: 'Preview image preview.png' })
    fireEvent.click(open)

    expect(view.getByRole('dialog', { name: 'Image preview' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Close image preview' }))
    await waitFor(() => { expect(view.queryByRole('dialog', { name: 'Image preview' })).toBeNull() })
  })

  it('keeps the message attachment independent from legacy approval projections', async () => {
    const source = {
      attachmentId: AttachmentId('source-a'),
      mediaType: 'image/png' as const,
      bytes: 68,
      width: 320,
      height: 200,
      name: 'source.png',
    }
    const loadImage = vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=')
    render(<MessageImageGallery {...({
      sessionId: 'session-a', images: [{ attachment: source }], align: 'start', loadImage,
      useProjection: () => { throw new Error('legacy approval projection must not be read') },
      controller: new WorkbenchController(), t: translate,
    } as unknown as MessageImageGalleryProps)} />)

    await waitFor(() => { expect(loadImage).toHaveBeenCalledWith(source) })
  })

  it('adds the edited guide through the official Harness composer image actions', () => {
    const attachment = {
      kind: 'image' as const,
      id: 'draft-image-a' as never,
      file: new File(['guide'], 'guide.png', { type: 'image/png' }),
      previewUrl: 'blob:guide-a',
    }
    const addImages = vi.fn(() => true)
    const setDraft = vi.fn()
    const releaseDraftImage = vi.fn()
    let insert: ((instruction: string, file: File) => boolean) | undefined
    const state = {
      draft: 'Keep this context', imageIds: [], draftRev: 3, phase: 'plain', occurrences: [], queue: [],
    }
    const props = {
      sessionId: 'session-a',
      useInput: (selector: (value: typeof state) => unknown) => selector(state),
      inputActions: { addImages, setDraft, removeImage: vi.fn(), pruneImages: vi.fn(), submit: vi.fn() },
      bindInserter: (_sessionId: string, value: typeof insert) => { insert = value; return vi.fn() },
      createDraftImages: vi.fn(() => [attachment]),
      releaseDraftImage,
    } as unknown as ImageStudioInputBridgeProps
    render(<ImageStudioInputBridge {...props} />)

    const file = new File(['edited'], 'image-studio-guide.png', { type: 'image/png' })
    expect(insert?.('Improve the surrounding garden', file)).toBe(true)
    expect(addImages).toHaveBeenCalledWith(['draft-image-a'])
    expect(setDraft).toHaveBeenCalledWith('Keep this context\nImprove the surrounding garden')
    expect(setDraft.mock.calls[0]?.[0]).not.toContain('@image-draft:')
    expect(releaseDraftImage).not.toHaveBeenCalled()
  })
})
