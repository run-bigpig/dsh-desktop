import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  defineImageTools,
  type ImageGenerateBatchResult,
  type ImageMutationResult,
  type ImageToolService,
} from '../src/image/tools.ts'

describe('image tools', () => {
  it('renders a completed mutation as official text and image blocks', () => {
    const tools = defineImageTools({} as ImageToolService)
    const tool = tools.find(candidate => candidate.name === 'image_generate')
    if (tool === undefined) throw new Error('image_generate was not registered')
    const value: ImageMutationResult = {
      taskId: 'task-a',
      revision: 2,
      status: 'completed',
      model: { provider: 'google', model: 'gemini-3.1-flash-image' },
      currentVersionId: 'version-a',
      operation: 'generate',
      image: {
        attachmentId: 'attachment-a',
        mediaType: 'image/png',
        bytes: 68,
        width: 1,
        height: 1,
        name: 'generated.png',
      },
    }

    expect(tool.output.render({}, value as never)).toEqual([
      { type: 'text', text: expect.stringContaining('"taskId": "task-a"') },
      {
        type: 'image',
        attachment: {
          attachmentId: 'attachment-a',
          mediaType: 'image/png',
          bytes: 68,
          width: 1,
          height: 1,
          name: 'generated.png',
        },
      },
    ])
  })

  it('generates different prompts concurrently and renders all successful images in one result', async () => {
    const first = mutation('task-a', 'attachment-a')
    const second = mutation('task-b', 'attachment-b')
    const generate = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const tool = defineImageTools({ generate } as unknown as ImageToolService)
      .find(candidate => candidate.name === 'image_generate')
    if (tool === undefined) throw new Error('image_generate was not registered')

    const value = await tool.execute({ prompts: ['A red kite', 'A blue sailboat'] }, {
      signal: new AbortController().signal,
      agent: { session: { id: 'session-a' } },
    } as never) as ImageGenerateBatchResult

    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate).toHaveBeenNthCalledWith(1, 'session-a', { prompt: 'A red kite' }, expect.any(AbortSignal))
    expect(generate).toHaveBeenNthCalledWith(2, 'session-a', { prompt: 'A blue sailboat' }, expect.any(AbortSignal))
    expect(value).toMatchObject({ status: 'completed', requested: 2, completed: 2, failed: 0 })
    expect(tool.output.render({}, value as never)).toEqual([
      { type: 'text', text: expect.stringContaining('"completed": 2') },
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'attachment-a' }) },
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'attachment-b' }) },
    ])
  })

  it('keeps successful batch images when another prompt fails', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(mutation('task-a', 'attachment-a'))
      .mockRejectedValueOnce(new Error('provider unavailable'))
    const tool = defineImageTools({ generate } as unknown as ImageToolService)
      .find(candidate => candidate.name === 'image_generate')
    if (tool === undefined) throw new Error('image_generate was not registered')

    const value = await tool.execute({ prompts: ['Keep me', 'Fail me'] }, {
      signal: new AbortController().signal,
      agent: { session: { id: 'session-a' } },
    } as never) as ImageGenerateBatchResult

    expect(value).toMatchObject({ status: 'partial', requested: 2, completed: 1, failed: 1 })
    expect(value.failures).toEqual([{ prompt: 'Fail me', error: 'provider unavailable' }])
    expect(tool.output.render({}, value as never)).toHaveLength(2)
  })

  it('fails the tool when every prompt fails', async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
    const tool = defineImageTools({ generate } as unknown as ImageToolService)
      .find(candidate => candidate.name === 'image_generate')
    if (tool === undefined) throw new Error('image_generate was not registered')

    await expect(tool.execute({ prompts: ['First', 'Second'] }, {
      signal: new AbortController().signal,
      agent: { session: { id: 'session-a' } },
    } as never)).rejects.toThrow(/all 2 image generations failed.*first failure.*second failure/)
  })

  it('validates prompt and prompts as mutually exclusive inputs', async () => {
    const tool = defineImageTools({} as ImageToolService).find(candidate => candidate.name === 'image_generate')
    if (tool === undefined) throw new Error('image_generate was not registered')
    const exec = { signal: new AbortController().signal, agent: { session: { id: 'session-a' } } } as never

    await expect(tool.execute({ prompt: 'One', prompts: ['Two'] }, exec)).rejects.toThrow(/mutually exclusive/)
    await expect(tool.execute({ prompts: [] }, exec)).rejects.toThrow(/exactly one/)
    await expect(tool.execute({ prompts: [' '] }, exec)).rejects.toThrow(/prompts\[0\] must be non-empty/)
  })

  it('declares mutating image tools as exclusive and read tools as concurrency-safe', () => {
    const tools = defineImageTools({ get: vi.fn() } as unknown as ImageToolService)
    expect(tools.find(tool => tool.name === 'image_generate')?.isConcurrencySafe).toBeUndefined()
    expect(tools.find(tool => tool.name === 'image_edit')?.isConcurrencySafe).toBeUndefined()
    expect(tools.find(tool => tool.name === 'image_task_get')?.isConcurrencySafe?.({ task_id: 'task-a' })).toBe(true)
    expect(tools.find(tool => tool.name === 'image_versions')?.isConcurrencySafe?.({ task_id: 'task-a' })).toBe(true)
  })

  it('edits the image attached to the current user message without a draft', async () => {
    const editSource = vi.fn().mockResolvedValue({ status: 'completed' })
    const service = { editSource } as unknown as ImageToolService
    const tool = defineImageTools(service).find(candidate => candidate.name === 'image_edit')
    if (tool === undefined) throw new Error('image_edit was not registered')

    const session = Session.create(SessionId('session-a'), [
      { ...userMessage([imageBlock('attachment-a')]), surfaceOp: 'append' } as SessionEvent,
    ])

    await tool.execute({
      instruction: 'Replace the marked sign',
    }, {
      signal: new AbortController().signal,
      agent: { session },
    } as never)

    expect(editSource).toHaveBeenCalledWith(
      'session-a', expect.objectContaining({ attachmentId: 'attachment-a' }),
      'Replace the marked sign', {}, expect.any(AbortSignal),
    )
  })

  it('does not reuse an image from an older user message', async () => {
    const editSource = vi.fn().mockResolvedValue({ status: 'completed' })
    const service = { editSource } as unknown as ImageToolService
    const tool = defineImageTools(service).find(candidate => candidate.name === 'image_edit')
    if (tool === undefined) throw new Error('image_edit was not registered')
    const exec = {
      signal: new AbortController().signal,
      agent: { session: { id: 'session-a', snapshotEvents: () => [
        userMessage([imageBlock('old-image')]),
        userMessage([{ type: 'text', text: 'Edit it' }]),
      ] } },
    } as never

    await expect(tool.execute({ instruction: 'Extend the surrounding garden' }, exec))
      .rejects.toThrow(/current user message does not contain an image/)
    expect(editSource).not.toHaveBeenCalled()
  })

  it('rejects multiple current-message images and explicit task edits without a revision', async () => {
    const tool = defineImageTools({} as ImageToolService).find(candidate => candidate.name === 'image_edit')
    if (tool === undefined) throw new Error('image_edit was not registered')
    const exec = {
      signal: new AbortController().signal,
      agent: { session: { id: 'session-a', snapshotEvents: () => [userMessage([
        imageBlock('attachment-a'), imageBlock('attachment-b'),
      ])] } },
    } as never

    await expect(tool.execute({ instruction: 'Edit' }, exec)).rejects.toThrow(/exactly one source image/)
    await expect(tool.execute({ task_id: 'task-a', instruction: 'Edit' }, exec))
      .rejects.toThrow(/expected_revision is required/)
  })
})

function mutation(taskId: string, attachmentId: string): ImageMutationResult {
  return {
    taskId,
    revision: 2,
    status: 'completed',
    model: { provider: 'google', model: 'gemini-image' },
    currentVersionId: `version-${taskId}`,
    operation: 'generate',
    image: {
      attachmentId,
      mediaType: 'image/png',
      bytes: 68,
      width: 1024,
      height: 1024,
      name: `${attachmentId}.png`,
    },
  }
}

function imageBlock(attachmentId: string) {
  return {
    type: 'image' as const,
    attachment: {
      attachmentId,
      mediaType: 'image/png' as const,
      bytes: 68,
      width: 1,
      height: 1,
      name: `${attachmentId}.png`,
    },
  }
}

function userMessage(content: readonly unknown[]) {
  return {
    type: 'user/message' as const,
    seq: 0,
    time: 0,
    data: { id: crypto.randomUUID(), role: 'user' as const, source: { kind: 'user' as const }, content },
  }
}
