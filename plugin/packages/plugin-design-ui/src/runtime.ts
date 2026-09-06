import { shallowReactive } from 'vue'
import { createEditor, type Editor } from '@open-pencil/core/editor'
import { BUILTIN_IO_FORMATS, IORegistry } from '@open-pencil/core/io'

import { startBridge } from './bridge.ts'

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
}

export interface DesignSession {
  connection: DesignConnection
  document: DesignDocument | null
  generation: number
  revision: number
  bridgePhase: 'disconnected' | 'connecting' | 'connected' | 'error'
  bridgeDetail: string
  mounts: number
  stopBridge?: () => void
  editorCleanup?: () => void
}

const sessions = new Map<string, DesignSession>()
export const documentIO = new IORegistry(BUILTIN_IO_FORMATS)

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
      mounts: 0
    })
    sessions.set(connection.sessionId, session)
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
  session.stopBridge?.()
  session.stopBridge = undefined
  session.bridgePhase = 'disconnected'
  session.bridgeDetail = session.document ? '画布未显示，Agent 已断开' : '请先新建或打开文档'
}

export function createBlankDocument(session: DesignSession): void {
  setDocument(session, createEditor(), '未命名.fig', undefined, -1)
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
  const editor = createEditor({ graph: imported.graph })
  const name = imported.sourceFormat === 'fig'
    ? file.name
    : `${file.name.replace(/\.[^.]+$/u, '')}.fig`
  setDocument(session, editor, name, imported.sourceFormat === 'fig' ? handle : undefined, editor.state.sceneVersion)
  queueMicrotask(() => editor.zoomToFit())
}

export async function saveDocument(session: DesignSession): Promise<'saved' | 'cancelled'> {
  const designDocument = session.document
  if (!designDocument) throw new Error('没有可保存的设计文档')
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
        types: [{ description: 'OpenPencil Document', accept: { 'application/octet-stream': ['.fig'] } }]
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
  designDocument.savedVersion = designDocument.editor.state.sceneVersion
  session.revision += 1
  return 'saved'
}

export function isDirty(session: DesignSession): boolean {
  const document = session.document
  return document !== null && document.savedVersion !== document.editor.state.sceneVersion
}

function setDocument(
  session: DesignSession,
  editor: Editor,
  name: string,
  handle: WritableFileHandle | undefined,
  savedVersion: number
): void {
  session.editorCleanup?.()
  const stops = [
    editor.onEditorEvent('render:requested', () => { session.revision += 1 }),
    editor.onEditorEvent('repaint:requested', () => { session.revision += 1 }),
    editor.onEditorEvent('selection:changed', () => { session.revision += 1 }),
    editor.onEditorEvent('tool:changed', () => { session.revision += 1 }),
    editor.onEditorEvent('page:changed', () => { session.revision += 1 })
  ]
  session.editorCleanup = () => { for (const stop of stops) stop() }
  session.document = shallowReactive({ editor, name, handle, savedVersion })
  session.generation += 1
  session.revision += 1
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
