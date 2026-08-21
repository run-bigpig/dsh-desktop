import { describe, expect, it } from 'vitest'
import { CallId, createMessage } from '@deepseek-ai/dsh-llm'
import { serializeMessages } from '../../../llm/llm-deepseek/src/serialize.ts'
import { syntheticLookAtCallChunks } from '../src/vision.ts'
import { normalizeLookAtReplayState } from '../src/vision-rewrite.ts'

describe('synthetic look_at_image stream', () => {
  it('preserves reasoning_content on a thinking-mode tool-call turn', () => {
    const chunks = syntheticLookAtCallChunks(CallId('look-at-1'), '{"images":[]}')
    const content = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])

    expect(content.map(block => block.type)).toEqual(['reasoning', 'tool-call'])
    expect(serializeMessages([createMessage({
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })])).toEqual([{
      role: 'assistant',
      content: '',
      reasoning_content: '查看图片以理解用户提供的内容。',
      tool_calls: [{
        id: 'look-at-1',
        type: 'function',
        function: { name: 'look_at_image', arguments: '{"images":[]}' },
      }],
    }])
  })

  it('repairs persisted look_at_image calls created before reasoning passback', () => {
    const repaired = normalizeLookAtReplayState({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('legacy-look-at'), name: 'look_at_image', arguments: '{"images":[]}' }],
        source: {
          kind: 'model',
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          replayState: { stale: true },
        },
      })],
    }, 'look_at_image')

    const assistant = repaired.messages[0]
    expect(assistant?.source).toEqual({
      kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    expect(serializeMessages(assistant === undefined ? [] : [assistant])).toEqual([{
      role: 'assistant',
      content: '',
      reasoning_content: '查看图片以理解用户提供的内容。',
      tool_calls: [{
        id: 'legacy-look-at',
        type: 'function',
        function: { name: 'look_at_image', arguments: '{"images":[]}' },
      }],
    }])
  })
})
