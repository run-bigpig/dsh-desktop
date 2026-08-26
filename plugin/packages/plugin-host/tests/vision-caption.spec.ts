import { describe, expect, it, vi } from 'vitest'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { captionImage, testVisionConnection } from '../src/vision-caption.ts'

const IMAGE: ImageAttachmentRef = {
  attachmentId: AttachmentId('image-1'),
  mediaType: 'image/png',
  bytes: 68,
  width: 1,
  height: 1,
  name: 'pixel.png',
}

describe('Harness vision model calls', () => {
  it('sends captioning through the selected Harness provider with an official image block', async () => {
    const stream = vi.fn((_options: unknown) => chunks([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'A single pixel.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'A single pixel.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const llm = { stream } as unknown as LlmRuntime

    await expect(captionImage(llm, { provider: 'vision-provider', model: 'vision-model' }, IMAGE))
      .resolves.toBe('A single pixel.')
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'vision-provider',
      model: 'vision-model',
      messages: [expect.objectContaining({
        content: expect.arrayContaining([{ type: 'image', attachment: IMAGE }]),
      })],
    }))
  })

  it('returns normalized Harness stream failures from the model test', async () => {
    const llm = {
      stream: () => chunks([{
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'AUTH', message: 'Credential is missing.' } },
      }]),
    } as unknown as LlmRuntime

    await expect(testVisionConnection(llm, { provider: 'vision-provider', model: 'vision-model' }))
      .resolves.toEqual({ kind: 'error', message: 'vision-bridge: vision model failed: Credential is missing.' })
  })
})

async function* chunks(values: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* values
}
