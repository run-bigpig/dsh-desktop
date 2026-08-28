import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AttachmentId, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export interface StoredImageRef {
  readonly attachmentId: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

export interface ImageVersionRecord {
  readonly id: string
  readonly parentVersionId?: string
  readonly attachment: StoredImageRef
  readonly instruction: string
  readonly operation: 'generate' | 'edit'
  readonly createdAt: string
}

export interface ImageTaskRecord {
  readonly id: string
  readonly sessionId: string
  readonly revision: number
  readonly model: { readonly provider: string; readonly model: string }
  readonly status: 'running' | 'completed' | 'failed'
  readonly currentVersionId?: string
  readonly versions: ImageVersionRecord[]
  readonly error?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface BegunImageEdit {
  readonly task: ImageTaskRecord
  readonly source: ImageVersionRecord
}

export interface LinkedImageVersion {
  readonly taskId: string
  readonly versionId: string
  readonly revision: number
  readonly model: ImageTaskRecord['model']
}

export class ImageTaskStore {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly root: string) {}

  beginGenerate(sessionId: string, model: ImageTaskRecord['model']): Promise<ImageTaskRecord> {
    return this.enqueue(async () => {
      const now = new Date().toISOString()
      const task: ImageTaskRecord = {
        id: randomUUID(),
        sessionId,
        revision: 1,
        model: { ...model },
        status: 'running',
        versions: [],
        createdAt: now,
        updatedAt: now,
      }
      await this.persist(task)
      return task
    })
  }

  beginFromSource(
    sessionId: string,
    model: ImageTaskRecord['model'],
    attachment: StoredImageRef,
  ): Promise<BegunImageEdit> {
    return this.enqueue(async () => {
      const now = new Date().toISOString()
      const source: ImageVersionRecord = {
        id: randomUUID(),
        attachment: { ...attachment },
        instruction: 'Source image attached in the conversation',
        operation: 'edit',
        createdAt: now,
      }
      const task: ImageTaskRecord = {
        id: randomUUID(),
        sessionId,
        revision: 1,
        model: { ...model },
        status: 'running',
        currentVersionId: source.id,
        versions: [source],
        createdAt: now,
        updatedAt: now,
      }
      await this.persist(task)
      return { task, source }
    })
  }

  beginEdit(
    sessionId: string,
    taskId: string,
    expectedRevision: number,
    sourceVersionId?: string,
  ): Promise<BegunImageEdit> {
    return this.enqueue(async () => {
      const current = await this.readOwned(sessionId, taskId)
      assertRevision(current, expectedRevision)
      if (current.status === 'running') throw new Error(`image-workbench: task ${taskId} is already running`)
      const sourceId = sourceVersionId ?? current.currentVersionId
      if (sourceId === undefined) throw new Error(`image-workbench: task ${taskId} has no image version`)
      const source = current.versions.find(version => version.id === sourceId)
      if (source === undefined) throw new Error(`image-workbench: version ${sourceId} does not belong to task ${taskId}`)
      const { error: _error, ...rest } = current
      const task: ImageTaskRecord = {
        ...rest,
        revision: current.revision + 1,
        status: 'running',
        updatedAt: new Date().toISOString(),
      }
      await this.persist(task)
      return { task, source }
    })
  }

  complete(
    sessionId: string,
    taskId: string,
    runningRevision: number,
    version: Omit<ImageVersionRecord, 'id' | 'createdAt'>,
  ): Promise<ImageTaskRecord> {
    return this.enqueue(async () => {
      const current = await this.readOwned(sessionId, taskId)
      assertRevision(current, runningRevision)
      if (current.status !== 'running') throw new Error(`image-workbench: task ${taskId} is not running`)
      const nextVersion: ImageVersionRecord = {
        ...version,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      }
      const task: ImageTaskRecord = {
        ...current,
        revision: current.revision + 1,
        status: 'completed',
        currentVersionId: nextVersion.id,
        versions: [...current.versions, nextVersion],
        updatedAt: new Date().toISOString(),
      }
      await this.persist(task)
      return task
    })
  }

  fail(sessionId: string, taskId: string, runningRevision: number, error: unknown): Promise<ImageTaskRecord> {
    return this.enqueue(async () => {
      const current = await this.readOwned(sessionId, taskId)
      assertRevision(current, runningRevision)
      if (current.status !== 'running') return current
      const task: ImageTaskRecord = {
        ...current,
        revision: current.revision + 1,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      }
      await this.persist(task)
      return task
    })
  }

  get(sessionId: string, taskId: string): Promise<ImageTaskRecord> {
    return this.enqueue(() => this.readOwned(sessionId, taskId))
  }

  findByAttachment(sessionId: string, attachmentId: string): Promise<LinkedImageVersion | undefined> {
    return this.enqueue(async () => {
      let entries
      try {
        entries = await readdir(resolve(this.root, 'tasks'), { withFileTypes: true })
      } catch (error) {
        if (isEnoent(error)) return undefined
        throw error
      }
      let match: { task: ImageTaskRecord; version: ImageVersionRecord } | undefined
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const taskId = entry.name.slice(0, -5)
        const task = await this.read(taskId)
        if (task.sessionId !== sessionId) continue
        const version = task.versions.find(candidate => candidate.attachment.attachmentId === attachmentId)
        if (version === undefined) continue
        if (match === undefined || task.updatedAt > match.task.updatedAt || task.currentVersionId === version.id) {
          match = { task, version }
        }
      }
      if (match === undefined) return undefined
      return {
        taskId: match.task.id,
        versionId: match.version.id,
        revision: match.task.revision,
        model: { ...match.task.model },
      }
    })
  }

  private async readOwned(sessionId: string, taskId: string): Promise<ImageTaskRecord> {
    const task = await this.read(taskId)
    if (task.sessionId !== sessionId) throw new Error(`image-workbench: task ${taskId} does not belong to this session`)
    return task
  }

  private async read(taskId: string): Promise<ImageTaskRecord> {
    assertTaskId(taskId)
    let text: string
    try {
      text = await readFile(this.filename(taskId), 'utf8')
    } catch (error) {
      if (isEnoent(error)) throw new Error(`image-workbench: task ${taskId} was not found`)
      throw error
    }
    return parseTask(text, taskId)
  }

  private persist(task: ImageTaskRecord): Promise<void> {
    return writeFileAtomic(this.filename(task.id), `${JSON.stringify(task, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  private filename(taskId: string): string {
    assertTaskId(taskId)
    return resolve(this.root, 'tasks', `${taskId}.json`)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

export function storedImageRef(ref: ImageAttachmentRef): StoredImageRef {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

export function attachmentRef(ref: StoredImageRef): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

function parseTask(text: string, expectedId: string): ImageTaskRecord {
  let value: unknown
  try { value = JSON.parse(text) } catch (error) {
    throw new Error(`image-workbench: task ${expectedId} is not valid JSON`, { cause: error })
  }
  const task = asRecord(value)
  if (task === undefined || task.id !== expectedId || typeof task.sessionId !== 'string'
    || !Number.isInteger(task.revision) || (task.status !== 'running' && task.status !== 'completed' && task.status !== 'failed')
    || !Array.isArray(task.versions) || typeof task.createdAt !== 'string' || typeof task.updatedAt !== 'string') {
    throw new Error(`image-workbench: task ${expectedId} is invalid`)
  }
  const model = asRecord(task.model)
  if (typeof model?.provider !== 'string' || typeof model.model !== 'string') {
    throw new Error(`image-workbench: task ${expectedId} has an invalid model`)
  }
  const versions = task.versions.map((entry, index) => parseVersion(entry, expectedId, index))
  return {
    id: expectedId,
    sessionId: task.sessionId,
    revision: task.revision as number,
    model: { provider: model.provider, model: model.model },
    status: task.status,
    ...(typeof task.currentVersionId === 'string' ? { currentVersionId: task.currentVersionId } : {}),
    versions,
    ...(typeof task.error === 'string' ? { error: task.error } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

function parseVersion(value: unknown, taskId: string, index: number): ImageVersionRecord {
  const version = asRecord(value)
  const attachment = asRecord(version?.attachment)
  if (typeof version?.id !== 'string' || typeof version.instruction !== 'string'
    || (version.operation !== 'generate' && version.operation !== 'edit') || typeof version.createdAt !== 'string'
    || typeof attachment?.attachmentId !== 'string' || !isImageMediaType(attachment.mediaType)
    || typeof attachment.bytes !== 'number' || typeof attachment.width !== 'number' || typeof attachment.height !== 'number') {
    throw new Error(`image-workbench: task ${taskId} version ${index} is invalid`)
  }
  return {
    id: version.id,
    ...(typeof version.parentVersionId === 'string' ? { parentVersionId: version.parentVersionId } : {}),
    attachment: {
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      bytes: attachment.bytes,
      width: attachment.width,
      height: attachment.height,
      ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
    },
    instruction: version.instruction,
    operation: version.operation,
    createdAt: version.createdAt,
  }
}

function assertRevision(task: ImageTaskRecord, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('image-workbench: expected_revision must be a positive integer')
  }
  if (task.revision !== expectedRevision) {
    throw new Error(`image-workbench: stale revision for task ${task.id}; expected ${expectedRevision}, current ${task.revision}`)
  }
}

function assertTaskId(taskId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(taskId)) {
    throw new Error('image-workbench: invalid task id')
  }
}

function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
