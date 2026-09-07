import { shallowReactive } from 'vue'
import type { Editor } from '@open-pencil/core/editor'

import { startBridge } from './bridge.ts'
import { createSessionEditor, decodeSessionDocument, documentIO } from './session-document.ts'
import { finishVectorEdit } from './vector-edit/adapter.ts'

export interface DesignConnection {
  baseUrl: string
  sessionId: string
  token: string
}

export interface WritableFileHandle {
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: Blob | BufferSource): Promise<void>; close(): Promise<void> }>
}

export interface DesignDocument {
  editor: Editor
  name: string
  handle?: WritableFileHandle
  savedVersion: number
  saving?: boolean
}

export interface DesignSession {
  binding?: { id: string; path: string; hash: string | null }
  connection: DesignConnection
  document: DesignDocument | null
  generation: number
  revision: number
  bridgePhase: 'disconnected' | 'connecting' | 'connected' | 'standby' | 'error'
  bridgeDetail: string
  mounts: number
  stopBridge?: () => void
  editorCleanup?: () => void
  persistNow?: () => Promise<void>
  schedulePersistence?: () => void
  restoreDocument?: (name: string, data: string) => Promise<void>
  persistenceError: string
}

const sessions = new Map<string, DesignSession>()
export function acquireSession(connection: DesignConnection): DesignSession {
  let session = sessions.get(connection.sessionId)
  if (!session) {
    session = shallowReactive<DesignSession>({
      connection,
      document: null,
      generation: 0,
      revision: 0,
      bridgePhase: 'disconnected',
      bridgeDetail: '请先新建或打开文档',
      mounts: 0,
      persistenceError: ''
    })
    sessions.set(connection.sessionId, session)
    session.restoreDocument = (name, data) => restoreSessionDocument(session!, name, data)
    createBlankDocument(session)
  } else {
    session.connection = connection
  }
  session.mounts += 1
  if (session.document && !session.stopBridge) session.stopBridge = startBridge(session)
  return session
}

export function releaseSession(session: DesignSession): void {
  session.mounts = Math.max(0, session.mounts - 1)
  if (session.mounts > 0) return
  if (session.document) finishVectorEdit(session.document.editor)
  const bridge = session.stopBridge
  const disconnect = (): void => {
    if (session.mounts > 0 || session.stopBridge !== bridge) return
    bridge?.()
    session.stopBridge = undefined
    session.bridgePhase = 'disconnected'
    session.bridgeDetail = '画布资源已释放'
    session.editorCleanup?.()
    sessions.delete(session.connection.sessionId)
  }
  // Flush the debounce before closing the socket. A quick session switch must
  // not discard the last manual edit and then restore an older snapshot.
  if (session.bridgePhase === 'connected' && session.persistNow) {
    void session.persistNow().catch(error => {
      session.persistenceError = `会话设计保存失败：${error instanceof Error ? error.message : String(error)}`
    }).finally(disconnect)
  } else disconnect()
}

export function createBlankDocument(session: DesignSession): void {
  setDocument(session, createSessionEditor(), '未命名.fig', undefined, -1)
}

export async function restoreSessionDocument(session: DesignSession, name: string, data: string): Promise<void> {
  const restored = await decodeSessionDocument(name, data)
  setDocument(session, restored.editor, restored.name, undefined, restored.editor.state.sceneVersion, false)
}

export async function openDocument(
  session: DesignSession,
  file: File,
  handle?: WritableFileHandle
): Promise<void> {
  const imported = await documentIO.readDocument({
    name: file.name,
    mimeType: file.type,
    data: new Uint8Array(await file.arrayBuffer())
  })
  const editor = createSessionEditor(imported.graph)
  const name = imported.sourceFormat === 'fig'
    ? file.name
    : `${file.name.replace(/\.[^.]+$/u, '')}.fig`
  setDocument(session, editor, name, imported.sourceFormat === 'fig' ? handle : undefined, editor.state.sceneVersion)
}

export async function saveDocument(session: DesignSession): Promise<'saved' | 'cancelled'> {
  const designDocument = session.document
  if (!designDocument) throw new Error('没有可保存的设计文档')
  finishVectorEdit(designDocument.editor)
  if (session.binding) {
    if (!session.persistNow || session.bridgePhase !== 'connected') throw new Error('画布尚未连接，无法保存到工作区')
    await session.persistNow()
    return 'saved'
  }
  const version = designDocument.editor.state.sceneVersion
  designDocument.saving = true
  try {
    const output = await documentIO.writeDocument('fig', designDocument.editor.graph, {
      thumbnailPageId: designDocument.editor.state.currentPageId,
      renderThumbnail: false
    })
    const bytes = typeof output.data === 'string' ? new TextEncoder().encode(output.data) : output.data
    let handle = designDocument.handle
    if (!handle && typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: normalizeFigName(designDocument.name),
          types: [{ description: 'StarWeave 设计文档', accept: { 'application/octet-stream': ['.fig'] } }]
        })
      } catch (error) {
        if (isAbortError(error)) return 'cancelled'
        throw error
      }
    }
    if (handle) {
      const writable = await handle.createWritable()
      try { await writable.write(bytes) } finally { await writable.close() }
      designDocument.handle = handle
      designDocument.name = (await handle.getFile()).name
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: output.mimeType }))
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = normalizeFigName(designDocument.name)
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    }
    designDocument.savedVersion = version
    if (session.document === designDocument) session.persistenceError = ''
    session.revision += 1
    return 'saved'
  } catch (error) {
    if (session.document === designDocument) session.persistenceError = `设计文件保存失败：${error instanceof Error ? error.message : String(error)}`
    throw error
  } finally { designDocument.saving = false }
}

export function isDirty(session: DesignSession): boolean {
  const document = session.document
  return document !== null && document.savedVersion !== document.editor.state.sceneVersion
}

export function saveState(session: DesignSession): 'saved' | 'unsaved' | 'saving' | 'error' {
  if (session.document?.saving) return 'saving'
  if (session.persistenceError) return 'error'
  return isDirty(session) ? 'unsaved' : 'saved'
}

function setDocument(
  session: DesignSession,
  editor: Editor,
  name: string,
  handle: WritableFileHandle | undefined,
  savedVersion: number,
  persist = true
): void {
  session.editorCleanup?.()
  const stops = [
    editor.onEditorEvent('render:requested', () => {
      session.revision += 1
      session.schedulePersistence?.()
    }),
    editor.onEditorEvent('repaint:requested', () => { session.revision += 1 }),
    editor.onEditorEvent('selection:changed', () => { session.revision += 1 }),
    editor.onEditorEvent('tool:changed', () => { session.revision += 1 }),
    editor.onEditorEvent('page:changed', () => { session.revision += 1 })
  ]
  session.editorCleanup = () => { for (const stop of stops) stop() }
  session.document = shallowReactive({ editor, name, handle, savedVersion })
  session.generation += 1
  session.revision += 1
  if (persist) session.schedulePersistence?.()
  if (session.mounts > 0 && !session.stopBridge) session.stopBridge = startBridge(session)
}

function normalizeFigName(name: string): string {
  return /\.fig$/iu.test(name) ? name : `${name}.fig`
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

declare global {
  interface Window {
    showSaveFilePicker?: (options: {
      suggestedName?: string
      types?: Array<{ description: string; accept: Record<string, string[]> }>
    }) => Promise<WritableFileHandle>
    showOpenFilePicker?: (options: {
      multiple?: boolean
      types?: Array<{ description: string; accept: Record<string, string[]> }>
    }) => Promise<WritableFileHandle[]>
  }
}
