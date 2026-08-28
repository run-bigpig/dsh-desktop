// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageStudio, type ImageStudioProps } from '../src/client/image/ImageStudio.tsx'
import { workbenchEn } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', {
    configurable: true,
    value: () => ({
      inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    }),
  })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: vi.fn(() => false) })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(SVGElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(SVGElement.prototype, 'hasPointerCapture', { configurable: true, value: vi.fn(() => false) })
  Object.defineProperty(SVGElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})

describe('image studio', () => {
  it('uses a focused outpaint canvas with eight custom resize handles', async () => {
    const view = render(<ImageStudio {...propsOf()} />)

    await view.findByRole('tab', { name: 'Outpaint' })
    expect(view.getAllByLabelText(/Resize outpaint area/)).toHaveLength(8)

    const right = view.getByLabelText('Resize outpaint area right')
    fireEvent.pointerDown(right, { button: 0, pointerId: 4, clientX: 400, clientY: 150 })
    fireEvent.pointerMove(right, { pointerId: 4, clientX: 500, clientY: 150 })
    fireEvent.pointerUp(right, { pointerId: 4, clientX: 500, clientY: 150 })

    expect(view.getByText('500 × 300 px')).toBeTruthy()
  })

  it('creates and erases fixed-red brush marks without exposing shape tools', async () => {
    const view = render(<ImageStudio {...propsOf()} />)
    await view.findByRole('tab', { name: 'Mark edit' })
    fireEvent.click(view.getByRole('tab', { name: 'Mark edit' }))

    expect(view.queryByTitle('Rectangle mark')).toBeNull()
    const canvas = view.getByRole('application', { name: 'Image editing canvas' })
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 7, clientX: 100, clientY: 80 })
    fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 140, clientY: 110 })
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 140, clientY: 110 })

    expect((view.getByRole('button', { name: 'Undo last' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(view.getByRole('button', { name: 'Eraser' }))
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 8, clientX: 120, clientY: 95 })
    fireEvent.pointerUp(canvas, { pointerId: 8, clientX: 120, clientY: 95 })

    expect((view.getByRole('button', { name: 'Undo last' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('submits the rendered guide and instruction directly to the session composer', async () => {
    const submitImage = vi.fn(() => true)
    const onReturn = vi.fn()
    mockGuideRendering()
    const view = render(<ImageStudio {...propsOf({ submitImage, onReturn })} />)
    await view.findByRole('tab', { name: 'Outpaint' })

    fireEvent.click(view.getByRole('button', { name: '2×' }))
    const canvas = view.getByRole('application', { name: 'Image editing canvas' })
    fireEvent.keyDown(canvas, { key: 'ArrowRight' })
    fireEvent.click(view.getByRole('tab', { name: 'Mark edit' }))
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 9, clientX: 260, clientY: 200 })
    fireEvent.pointerUp(canvas, { pointerId: 9, clientX: 260, clientY: 200 })
    fireEvent.change(view.getByLabelText('Edit instruction'), { target: { value: 'Extend the garden and replace the marked vase.' } })
    fireEvent.click(view.getByRole('button', { name: 'Send to agent' }))

    await waitFor(() => {
      expect(submitImage).toHaveBeenCalledWith(
        'session-a',
        'Extend the garden and replace the marked vase.',
        expect.objectContaining({ name: 'image-studio-guide.png', type: 'image/png' }),
      )
    })
    expect(onReturn).toHaveBeenCalledOnce()
  })
})

function propsOf(overrides: Partial<ImageStudioProps> = {}): ImageStudioProps {
  return {
    sessionId: 'session-a',
    intent: {
      sessionId: 'session-a',
      sourceImage: imageOf('source-a'),
      label: 'source.png',
      loadImage: vi.fn().mockResolvedValue('data:image/png;base64,AA=='),
    },
    submitImage: vi.fn(() => true),
    onReturn: vi.fn(),
    t: key => workbenchEn[key],
    ...overrides,
  }
}

function imageOf(attachmentId: string) {
  return {
    attachmentId,
    mediaType: 'image/png' as const,
    bytes: 1024,
    width: 400,
    height: 300,
    name: `${attachmentId}.png`,
  }
}

function mockGuideRendering(): void {
  const context = {
    arc: vi.fn(), beginPath: vi.fn(), clearRect: vi.fn(), closePath: vi.fn(), drawImage: vi.fn(),
    ellipse: vi.fn(), fill: vi.fn(), fillText: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(), restore: vi.fn(),
    save: vi.fn(), setLineDash: vi.fn(), stroke: vi.fn(), strokeRect: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback) => { callback(new Blob(['guide'], { type: 'image/png' })) },
  })
  class TestImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) { queueMicrotask(() => { this.onload?.() }) }
  }
  vi.stubGlobal('Image', TestImage)
}
