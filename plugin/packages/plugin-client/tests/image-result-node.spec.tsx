// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  ImageResultNode,
  type ImageResultNodeProps,
  imageResultDefinition,
} from '../src/client/image/ImageResultNode.tsx'
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

describe('image result node', () => {
  it('projects successful image tool attachments beside the final answer', () => {
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
    state = update(state, match(4, 'assistant/message', {
      turn: 4,
      step: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: '图片已生成' }] },
    }))
    state = update(state, match(5, 'turn/end', { turn: 4, reason: { kind: 'completed' } }))

    const node = imageResultDefinition.buildViewNode?.({
      key: '21:desktop-image-results4',
      kind: 'desktop-image-results',
      id: '4',
      start: turnStart,
      matches: [turnStart],
      state,
      current: new Map(),
    } as never)

    expect(node).toMatchObject({
      key: 'zz:21:desktop-image-results4',
      kind: 'image-results',
      anchorSeq: 4,
      data: { images: [attachment] },
    })
  })

  it('ignores failed and unrelated tool results', () => {
    const turnStart = match(1, 'turn/start', { turn: 1 }, 'start')
    let state = imageResultDefinition.start({} as never, turnStart as never, {} as never)
    state = update(state, match(2, 'tool/call', {
      turn: 1, step: 1, callId: 'call-read', name: 'read', arguments: '{}',
    }))
    state = update(state, match(3, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        source: { type: 'tool-result', callId: 'call-read' },
        content: [{ type: 'tool-result', toolCallId: 'call-read', isError: false, content: [{ type: 'image', attachment }] }],
      },
    }))
    state = update(state, match(4, 'tool/call', {
      turn: 1, step: 1, callId: 'call-failed-image', name: 'image_generate', arguments: '{}',
    }))
    state = update(state, match(5, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        source: { type: 'tool-result', callId: 'call-failed-image' },
        content: [{ type: 'tool-result', toolCallId: 'call-failed-image', isError: true, content: [{ type: 'image', attachment }] }],
      },
    }))
    state = update(state, match(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))

    expect(imageResultDefinition.buildViewNode?.({
      key: 'key', kind: 'desktop-image-results', id: '1', start: turnStart, matches: [turnStart], state, current: new Map(),
    } as never)).toBeNull()
  })

  it('renders the promoted image through the shared gallery', async () => {
    const view = render(<ImageResultNode {...({
      node: { data: { images: [attachment] } },
      sessionId: 'session-a',
      loadImage: vi.fn().mockResolvedValue('data:image/png;base64,AA=='),
      controller: { openImage: vi.fn() },
      t: translate,
    } as unknown as ImageResultNodeProps)} />)

    expect(await view.findByRole('img', { name: 'final.png' })).toBeTruthy()
  })
})

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
