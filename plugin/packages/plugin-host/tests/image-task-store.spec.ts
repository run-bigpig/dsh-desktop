import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageTaskStore } from '../src/image/task-store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('image task store', () => {
  it('persists a generated version and enforces session ownership', async () => {
    const store = await createStore()
    const begun = await store.beginGenerate('session-a', { provider: 'google', model: 'gemini-3.1-flash-image' })
    const completed = await store.complete('session-a', begun.id, begun.revision, {
      attachment: imageRef('attachment-a'),
      instruction: 'Draw a lighthouse',
      operation: 'generate',
    })

    expect(completed).toMatchObject({ revision: 2, status: 'completed' })
    expect(completed.currentVersionId).toBe(completed.versions[0]?.id)
    await expect(store.get('session-b', begun.id)).rejects.toThrow(/does not belong to this session/)
  })

  it('uses revision CAS before starting an edit', async () => {
    const store = await createStore()
    const begun = await store.beginGenerate('session-a', { provider: 'openai', model: 'gpt-image-2' })
    const completed = await store.complete('session-a', begun.id, begun.revision, {
      attachment: imageRef('attachment-a'),
      instruction: 'Draw a lighthouse',
      operation: 'generate',
    })

    await expect(store.beginEdit('session-a', completed.id, completed.revision - 1)).rejects.toThrow(/stale revision/)
    const edit = await store.beginEdit('session-a', completed.id, completed.revision)
    expect(edit.task).toMatchObject({ revision: completed.revision + 1, status: 'running' })
    await expect(store.beginEdit('session-a', completed.id, completed.revision)).rejects.toThrow(/stale revision/)
  })

  it('starts a conversation image as a versioned edit task', async () => {
    const store = await createStore()
    const begun = await store.beginFromSource(
      'session-a',
      { provider: 'google', model: 'gemini-3.1-flash-image' },
      imageRef('source-a'),
    )

    expect(begun.task).toMatchObject({ revision: 1, status: 'running', currentVersionId: begun.source.id })
    expect(begun.task.versions).toHaveLength(1)
    const completed = await store.complete('session-a', begun.task.id, begun.task.revision, {
      parentVersionId: begun.source.id,
      attachment: imageRef('result-a'),
      instruction: 'Extend the sky',
      operation: 'edit',
    })
    expect(completed).toMatchObject({ revision: 2, status: 'completed' })
    expect(completed.versions).toHaveLength(2)
    await expect(store.findByAttachment('session-a', 'result-a')).resolves.toEqual({
      taskId: completed.id,
      versionId: completed.currentVersionId,
      revision: completed.revision,
      model: { provider: 'google', model: 'gemini-3.1-flash-image' },
    })
    await expect(store.findByAttachment('session-b', 'result-a')).resolves.toBeUndefined()
  })
})

async function createStore(): Promise<ImageTaskStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-task-'))
  roots.push(root)
  return new ImageTaskStore(root)
}

function imageRef(attachmentId: string) {
  return {
    attachmentId,
    mediaType: 'image/png' as const,
    bytes: 68,
    width: 1,
    height: 1,
    name: 'pixel.png',
  }
}
