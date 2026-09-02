// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  ImageResultTail,
  type ImageResultTailProps,
  imageResultDefinition,
  selectImageResultTail,
} from '../src/client/image/ImageResultTail.tsx'
import { workbenchEn } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const attachment = {
  attachmentId: AttachmentId('attachment-final'),
  mediaType: 'image/png',
  bytes: 68,
  width: 1024,
  height: 1024,
  name: 'final.png',
}

function translate(key: keyof typeof workbenchEn, params?: Record<string, string | number>): string {
  return Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    workbenchEn[key],
  )
}

describe('image result tail', () => {
  it('publishes successful image tool attachments as Turn data', () => {
    const turnStart = match(1, 'turn/start', { turn: 4 }, 'start')
    let state = imageResultDefinition.start({} as never, turnStart as never, {} as never)
    state = update(state, match(2, 'tool/call', {
      turn: 4, step: 1, callId: 'call-image', name: 'image_generate', arguments: '{}',
    }))
    state = update(state, match(3, 'tool/result', {
      turn: 4,
      step: 1,
      message: {
        source: { type: 'tool-result', callId: 'call-image' },
        content: [{ type: 'tool-result', toolCallId: 'call-image', isError: false, content: [
          { type: 'text', text: '{}' },
          { type: 'image', attachment },
        ] }],
      },
    }))

    expect(imageResultDefinition.buildLocationData?.({ state } as never, 'turn')).toEqual({
      kind: 'turn',
      turn: 4,
      key: 'desktop-image-results',
      value: { images: [{ seq: 3, attachment }] },
    })
  })

  it('selects only images settled before the closing assistant', () => {
    const data = { images: [{ seq: 3, attachment }, { seq: 8, attachment: { ...attachment, attachmentId: AttachmentId('later') } }] }
    const selected = selectImageResultTail({
      seq: 5,
      openFile: vi.fn(),
      turn: { data: { get: () => data } },
    } as never)

    expect(selected).toEqual([attachment])
  })

  it('ignores failed and unrelated tool results', () => {
    const turnStart = match(1, 'turn/start', { turn: 1 }, 'start')
    let state = imageResultDefinition.start({} as never, turnStart as never, {} as never)
    state = update(state, match(2, 'tool/call', {
      turn: 1, step: 1, callId: 'call-read', name: 'read', arguments: '{}',
    }))
    state = update(state, match(3, 'tool/result', resultData('call-read', false)))
    state = update(state, match(4, 'tool/call', {
      turn: 1, step: 1, callId: 'call-failed-image', name: 'image_generate', arguments: '{}',
    }))
    state = update(state, match(5, 'tool/result', resultData('call-failed-image', true)))

    expect(imageResultDefinition.buildLocationData?.({ state } as never, 'turn')).toMatchObject({
      value: { images: [] },
    })
  })

  it('renders the promoted image through the shared gallery', async () => {
    const view = render(<ImageResultTail {...({
      matched: [attachment],
      sessionId: 'session-a',
      loadImage: vi.fn().mockResolvedValue('data:image/png;base64,AA=='),
      controller: { openImage: vi.fn() },
      t: translate,
    } as unknown as ImageResultTailProps)} />)

    expect(await view.findByRole('img', { name: 'final.png' })).toBeTruthy()
  })
})

function resultData(callId: string, isError: boolean) {
  return {
    turn: 1,
    step: 1,
    message: {
      source: { type: 'tool-result', callId },
      content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'image', attachment }] }],
    },
  }
}

function match(seq: number, type: string, data: unknown, role = 'update') {
  return {
    event: { seq, time: seq, type, data },
    role,
    location: { kind: 'turn', turn: { turn: 1, status: 'closed', steps: [], data: { get: () => undefined } } },
  }
}

function update(state: ReturnType<typeof imageResultDefinition.start>, value: ReturnType<typeof match>) {
  return imageResultDefinition.update({ state } as never, value as never)
}
