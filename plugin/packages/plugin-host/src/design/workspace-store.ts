import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { resolveWorkspaceFilePath } from '../workspace/index.ts'
import { createDesignDocumentStore, MAX_DESIGN_DOCUMENT_BASE64_LENGTH, type DesignDocumentStore, type StoredDesignDocument } from './storage.ts'

type Binding = NonNullable<StoredDesignDocument['binding']>

/** A session owns the editor; the workspace file owns the durable design. */
export class WorkspaceDesignStore implements DesignDocumentStore {
  private readonly recovery: DesignDocumentStore
  private binding: Binding | undefined
  private lastSaved: { path: string; hash: string } | undefined

  constructor(private readonly root: string, private readonly recoveryPath: string) {
    this.recovery = createDesignDocumentStore(recoveryPath)
  }

  async load(): Promise<StoredDesignDocument | undefined> {
    if (this.binding) return this.readBound()
    const snapshot = await this.recovery.load()
    if (snapshot?.binding) {
      const disk = await this.select(snapshot.binding.path, false)
      // Replay a recovery snapshot only against the disk version it was based on.
      return snapshot.binding.hash === this.binding!.hash
        ? { ...snapshot, binding: this.currentBinding()!, unsaved: hash(Buffer.from(snapshot.data, 'base64')) !== this.currentBinding()!.hash }
        : disk
    }
    await this.select(`designs/design-${randomUUID().slice(0, 8)}.fig`, true)
    return snapshot ? { ...snapshot, name: basename(this.binding!.path), binding: this.currentBinding()!, unsaved: true } : undefined
  }

  currentBinding(): Binding | undefined { return this.binding }

  async select(path: string, create: boolean): Promise<StoredDesignDocument | undefined> {
    if (!/\.fig$/iu.test(path)) throw new Error('画布文件必须使用 .fig 扩展名')
    const target = await resolveWorkspaceFilePath(this.root, path)
    const data = await readOptional(target.absolute)
    if (create && data) throw new Error('目标设计文件已存在，请打开已有文件或选择新的名称')
    if (!create && !data) throw new Error('设计文件不存在，请从工作区选择现有文件')
    this.binding = { id: randomUUID(), path: target.path, hash: data ? hash(data) : null }
    this.lastSaved = data ? { path: target.path, hash: hash(data) } : undefined
    return data ? { name: basename(target.path), data: data.toString('base64'), binding: this.currentBinding()! } : undefined
  }

  async remember(document: StoredDesignDocument): Promise<void> {
    if (document.binding?.id !== this.binding?.id) throw new Error('画布文件已切换')
    await this.recovery.save(document)
  }

  async preserveRecovery(): Promise<void> {
    const snapshot = await this.recovery.load()
    if (snapshot) await createDesignDocumentStore(`${this.recoveryPath}.${randomUUID()}.recovery.json`).save(snapshot)
  }

  restoreBinding(binding: Binding): void { this.binding = binding; this.lastSaved = undefined }

  private async readBound(): Promise<StoredDesignDocument | undefined> {
    const binding = this.binding!
    const target = await resolveWorkspaceFilePath(this.root, binding.path)
    const disk = await readOptional(target.absolute)
    if (!disk && binding.hash !== null) throw new Error('工作区设计文件已被删除；恢复快照仍保留在会话中')
    if (!disk) return undefined
    const snapshot = await this.recovery.load()
    this.binding = { ...binding, hash: hash(disk) }
    return snapshot?.binding?.path === binding.path && snapshot.binding.hash === hash(disk)
      ? { ...snapshot, binding: this.currentBinding()!, unsaved: hash(Buffer.from(snapshot.data, 'base64')) !== this.currentBinding()!.hash }
      : { name: basename(binding.path), data: disk.toString('base64'), binding: this.currentBinding()! }
  }

  async save(document: StoredDesignDocument): Promise<void> {
    const binding = this.binding
    if (!binding || document.binding?.id !== binding.id) throw new Error('画布文件已切换，旧文档不能覆盖当前文件')
    const target = await resolveWorkspaceFilePath(this.root, binding.path)
    await mkdir(dirname(target.absolute), { recursive: true })
    await withFileLock(target.absolute, async () => {
      if (this.binding?.id !== binding.id) throw new Error('画布文件已切换')
      // Preserve edits even when the disk conflict check refuses the write.
      await this.recovery.save({ ...document, name: basename(binding.path), binding: { ...binding } })
      const previous = await readOptional(target.absolute)
      if ((previous ? hash(previous) : null) !== binding.hash) {
        throw new Error('工作区设计文件已被其他编辑器修改，已保留恢复快照。请重新打开磁盘文件后编辑，避免覆盖外部修改。')
      }
      const data = Buffer.from(document.data, 'base64')
      const nextHash = hash(data)
      if (nextHash !== binding.hash) await writeBinaryAtomic(target.absolute, data)
      binding.hash = nextHash
      this.lastSaved = { path: binding.path, hash: nextHash }
      await this.recovery.save({ ...document, name: basename(binding.path), binding: { ...binding } })
    })
  }

  artifact(): { kind: 'starweave-canvas'; path: string; name: string; hash: string; saved: true } {
    if (!this.lastSaved) throw new Error('设计尚未成功保存到工作区')
    return { kind: 'starweave-canvas', ...this.lastSaved, name: basename(this.lastSaved.path), saved: true }
  }
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_DESIGN_DOCUMENT_BASE64_LENGTH / 4 * 3) throw new Error('设计文件不是有效文件或超过 36 MiB 限制')
    const data = await readFile(path)
    if (data.length > MAX_DESIGN_DOCUMENT_BASE64_LENGTH / 4 * 3) throw new Error('设计文件超过 36 MiB 限制')
    return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function hash(data: Buffer): string { return createHash('sha256').update(data).digest('hex') }

async function writeBinaryAtomic(filename: string, data: Buffer): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break } catch (error) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EACCES', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
      }
    }
  } finally { await rm(temporary, { force: true }) }
}
