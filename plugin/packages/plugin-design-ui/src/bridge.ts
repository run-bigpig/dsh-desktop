import { renderNodesToImage } from '@open-pencil/core/io'
import { FigmaAPI } from '@open-pencil/core/figma-api'
import { computeAllLayouts } from '@open-pencil/core/layout'
import { ALL_TOOLS } from '@open-pencil/core/tools'
import type { Editor } from '@open-pencil/core/editor'

import type { DesignSession } from './runtime.ts'
import { encodeSessionDocument } from './session-document.ts'
import { restoreDocumentSnapshot, snapshotDocument } from './document-history.ts'
import { finishVectorEdit } from './vector-edit/adapter.ts'
import { editSharedStyle, type SharedStyleOperation } from './shared-styles.ts'

const PERSISTENCE_DELAY_MS = 300
const PERSISTENCE_TIMEOUT_MS = 30_000

type PendingPersistence = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function startBridge(session: DesignSession): () => void {
  let stopped = false
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  let messages = Promise.resolve()
  let persistence = Promise.resolve()
  let persistenceEnabled = false
  const pendingPersistence = new Map<string, PendingPersistence>()

  const persistDocument = (): Promise<void> => {
    clearTimeout(persistTimer)
    persistTimer = undefined
    if (!persistenceEnabled) return Promise.resolve()
    const operation = persistence.catch(() => undefined).then(async () => {
      const current = socket
      const document = session.document
      if (!current || current.readyState !== WebSocket.OPEN || !document) {
        throw new Error('设计会话未连接，无法保存会话快照')
      }
      const id = crypto.randomUUID()
      const data = await encodeSessionDocument(document.editor)
      const saved = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPersistence.delete(id)
          reject(new Error('设计会话快照保存超时'))
        }, PERSISTENCE_TIMEOUT_MS)
        pendingPersistence.set(id, { resolve, reject, timer })
      })
      current.send(JSON.stringify({
        type: 'persist_document',
        id,
        document: { name: document.name, data }
      }))
      await saved
      session.persistenceError = ''
    })
    persistence = operation
    return operation
  }

  const schedulePersistence = (): void => {
    if (!persistenceEnabled || stopped) return
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void persistDocument().catch(error => {
        session.persistenceError = `会话设计保存失败：${error instanceof Error ? error.message : String(error)}`
      })
    }, PERSISTENCE_DELAY_MS)
  }

  session.persistNow = persistDocument
  session.schedulePersistence = schedulePersistence

  const connect = (): void => {
    if (stopped || !session.document) return
    session.bridgePhase = 'connecting'
    session.bridgeDetail = '正在连接 Agent…'
    const url = new URL('/bridge', session.connection.baseUrl)
    url.protocol = 'ws:'
    const current = new WebSocket(url)
    socket = current
    current.addEventListener('open', () => {
      current.send(JSON.stringify({
        type: 'register',
        sessionId: session.connection.sessionId,
        token: session.connection.token
      }))
    })
    current.addEventListener('message', event => {
      const message = parseMessage(event.data)
      if (!message) return
      if (settlePersistence(message, pendingPersistence)) return
      messages = messages.then(() => handleMessage(session, current, message, enabled => {
        persistenceEnabled = enabled
      }))
    })
    current.addEventListener('close', event => {
      if (socket === current) socket = undefined
      persistenceEnabled = false
      rejectPersistence(pendingPersistence, new Error('设计会话连接已断开'))
      if (stopped || event.code === 1000) return
      if (event.code === 4001) {
        session.bridgePhase = 'disconnected'
        session.bridgeDetail = '当前设计已在另一个窗口中打开'
        return
      }
      session.bridgePhase = 'disconnected'
      session.bridgeDetail = 'Agent 已断开，正在重连…'
      retry = setTimeout(connect, 1500)
    })
    current.addEventListener('error', () => {
      session.bridgePhase = 'error'
      session.bridgeDetail = '无法连接 Agent，正在重试…'
      current.close()
    })
  }

  connect()
  return () => {
    stopped = true
    clearTimeout(retry)
    clearTimeout(persistTimer)
    if (session.persistNow === persistDocument) session.persistNow = undefined
    if (session.schedulePersistence === schedulePersistence) session.schedulePersistence = undefined
    rejectPersistence(pendingPersistence, new Error('设计画布已关闭'))
    socket?.close(1000, 'design view closed')
  }
}

async function handleMessage(
  session: DesignSession,
  socket: WebSocket,
  message: Record<string, unknown>,
  setPersistenceEnabled: (enabled: boolean) => void
): Promise<void> {
  if (message.type === 'registered') {
    setPersistenceEnabled(false)
    session.persistenceError = typeof message.restoreError === 'string' && message.restoreError
      ? `会话设计恢复失败：${message.restoreError}`
      : ''
    if (session.persistenceError) {
      session.bridgePhase = 'error'
      session.bridgeDetail = '会话设计恢复失败，重新打开会话以重试'
      return
    }
    const saved = record(message.document)
    if (typeof saved.name === 'string' && typeof saved.data === 'string') {
      try {
        if (!session.restoreDocument) throw new Error('设计会话恢复器未初始化')
        await session.restoreDocument(saved.name, saved.data)
      } catch (error) {
        session.persistenceError = `会话设计恢复失败：${error instanceof Error ? error.message : String(error)}`
        session.bridgePhase = 'error'
        session.bridgeDetail = '会话设计恢复失败，重新打开会话以重试'
        return
      }
    }
    setPersistenceEnabled(message.persistence === true)
    session.bridgePhase = 'connected'
    session.bridgeDetail = 'Agent 已连接当前文档'
    return
  }
  if (message.type !== 'request' || typeof message.id !== 'string' || typeof message.command !== 'string') return
  try {
    if (session.bridgePhase === 'error') throw new Error(session.persistenceError || session.bridgeDetail)
    const body = await execute(session, message.command, message.args)
    send(socket, { type: 'response', id: message.id, ...asResponse(body) })
  } catch (error) {
    send(socket, {
      type: 'response',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function execute(session: DesignSession, command: string, args: unknown): Promise<unknown> {
  const document = session.document
  if (!document) throw new Error('请先在设计模式中创建或打开文档')
  document.editor.flushNudge()
  finishVectorEdit(document.editor)
  if (command === 'shared_style') {
    const result = editSharedStyle(document.editor, args as SharedStyleOperation)
    await waitForRender(document.editor)
    if (record(args).action !== 'list') await session.persistNow?.()
    return { ok: true, result }
  }
  if (command === 'undo' || command === 'redo') {
    if (command === 'undo') document.editor.undoAction()
    else document.editor.redoAction()
    await waitForRender(document.editor)
    await session.persistNow?.()
    return { ok: true, result: { completed: command } }
  }
  if (command === 'list_documents') {
    const page = document.editor.graph.getNode(document.editor.state.currentPageId)
    return {
      ok: true,
      result: {
        documents: [{
          id: session.connection.sessionId,
          name: document.name,
          active: true,
          current_page_id: document.editor.state.currentPageId,
          current_page_name: page?.name ?? '',
          pages: document.editor.graph.getPages().map(item => ({ id: item.id, name: item.name }))
        }]
      }
    }
  }
  if (command !== 'tool') throw new Error(`Unsupported design command: ${command}`)
  const envelope = record(args)
  if (envelope.document_id !== session.connection.sessionId) throw new Error('Agent 只能操作当前设计会话的文档')
  const name = typeof envelope.name === 'string' ? envelope.name : ''
  const definition = ALL_TOOLS.find(tool => tool.name === name)
  if (!definition) throw new Error(`Unknown StarWeave design tool: ${name}`)
  const toolArgs = record(envelope.args)
  const editor = document.editor
  const pageId = typeof envelope.page_id === 'string' ? envelope.page_id : editor.state.currentPageId
  const page = editor.graph.getNode(pageId)
  if (page?.type !== 'CANVAS') throw new Error(`Page not found: ${pageId}`)
  const figma = new FigmaAPI(editor.graph)
  figma.currentPage = figma.wrapNode(pageId)
  figma.currentPage.selection = [...editor.state.selectedIds]
    .map(id => figma.getNodeById(id))
    .filter(item => item !== null)
  figma.setRenderer(editor.renderer)
  const viewportWidth = editor.renderer?.viewportWidth ?? window.innerWidth
  const viewportHeight = editor.renderer?.viewportHeight ?? window.innerHeight
  figma.viewport = {
    center: {
      x: (-editor.state.panX + viewportWidth / 2) / editor.state.zoom,
      y: (-editor.state.panY + viewportHeight / 2) / editor.state.zoom
    },
    zoom: editor.state.zoom
  }
  if (editor.renderer) {
    figma.exportImage = async (ids, options) => renderNodesToImage(
      editor.renderer!.ck,
      editor.renderer!,
      editor.graph,
      pageId,
      ids,
      { scale: options.scale ?? 1, format: options.format ?? 'PNG', quality: options.quality }
    )
  }
  const viewOnly = ['select_nodes', 'switch_page', 'viewport_set', 'viewport_zoom_to_fit'].includes(name)
  const beforeSnapshot = definition.mutates && !viewOnly ? snapshotDocument(editor) : null
  let result: unknown
  let resultNodeIds: string[] = []
  try {
    result = await definition.execute(figma, toolArgs)
    const value = record(result)
    if (typeof value.error === 'string') throw new Error(value.error)
    if (Array.isArray(value.errors) && value.errors.length) throw new Error(value.errors.join('; '))
    if (definition.mutates) resultNodeIds = assertMutationApplied(editor, name, result)
  } catch (error) {
    if (beforeSnapshot) restoreDocumentSnapshot(editor, beforeSnapshot)
    throw error
  }
  if (definition.mutates) {
    const targetPageId = figma.currentPageId
    if (editor.state.currentPageId !== targetPageId) editor.switchPage(targetPageId)
    computeAllLayouts(editor.graph, targetPageId)
    applyViewport(editor, figma.viewport)
    if (name === 'select_nodes') editor.select(figma.currentPage.selection.map(node => node.id))
    if (name === 'viewport_zoom_to_fit') {
      const bounds = record(record(result).bounds)
      editor.zoomToBounds(Number(bounds.x), Number(bounds.y), Number(bounds.x) + Number(bounds.width), Number(bounds.y) + Number(bounds.height))
    }
    if (['create_shape', 'render', 'import_svg', 'create_vector', 'insert_icon', 'create_instance', 'clone_node'].includes(name) && resultNodeIds.length > 0) {
      editor.select(resultNodeIds.filter(id => editor.graph.getNode(id)?.type !== 'CANVAS'))
      editor.zoomToSelection()
    }
    editor.requestRender()
    await waitForRender(editor)
    if (beforeSnapshot) {
      const afterSnapshot = snapshotDocument(editor)
      editor.pushUndoEntry({
        label: `AI: ${name}`,
        forward: () => restoreDocumentSnapshot(editor, afterSnapshot),
        inverse: () => restoreDocumentSnapshot(editor, beforeSnapshot)
      })
    }
    await session.persistNow?.()
  }
  return { ok: true, result }
}

function assertMutationApplied(
  editor: Editor,
  name: string,
  result: unknown
): string[] {
  const value = record(result)
  if (typeof value.error === 'string') throw new Error(value.error)
  if (name === 'create_collection') {
    if (!editor.graph.variableCollections.has(String(value.id))) throw new Error('Variable collection was not created')
    return []
  }
  if (name === 'create_variable' || name === 'set_variable') {
    if (!editor.graph.variables.has(String(value.id))) throw new Error('Variable was not updated')
    return []
  }
  if (name.startsWith('delete_')) return []
  const ids = [
    typeof value.id === 'string' ? value.id : undefined,
    ...(Array.isArray(value.results)
      ? value.results.map(item => typeof record(item).id === 'string' ? record(item).id as string : undefined)
      : []),
    ...(Array.isArray(value.siblings) ? value.siblings.map(item => record(item).id as string) : [])
  ].filter((id): id is string => id !== undefined)
  for (const id of ids) {
    if (!editor.graph.getNode(id)) throw new Error(`StarWeave design mutation did not commit node "${id}"`)
  }
  return ids
}

function applyViewport(editor: Editor, viewport: FigmaAPI['viewport']): void {
  const renderer = editor.renderer
  if (!renderer) return
  const { center, zoom } = viewport
  const panX = renderer.viewportWidth / 2 - center.x * zoom
  const panY = renderer.viewportHeight / 2 - center.y * zoom
  if (editor.state.zoom === zoom && editor.state.panX === panX && editor.state.panY === panY) return
  editor.state.zoom = zoom
  editor.state.panX = panX
  editor.state.panY = panY
  editor.requestRepaint()
}

async function waitForRender(editor: Editor): Promise<void> {
  if (!editor.renderer) return
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

function asResponse(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { ok: true, result: value }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function send(socket: WebSocket, message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function parseMessage(raw: unknown): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(String(raw)) as unknown
    return record(value)
  } catch {
    return undefined
  }
}

function settlePersistence(
  message: Record<string, unknown>,
  pending: Map<string, PendingPersistence>
): boolean {
  if ((message.type !== 'persisted' && message.type !== 'persistence_error') || typeof message.id !== 'string') {
    return false
  }
  const operation = pending.get(message.id)
  if (!operation) return true
  pending.delete(message.id)
  clearTimeout(operation.timer)
  if (message.type === 'persisted') operation.resolve()
  else operation.reject(new Error(typeof message.error === 'string' ? message.error : '会话设计保存失败'))
  return true
}

function rejectPersistence(pending: Map<string, PendingPersistence>, error: Error): void {
  for (const operation of pending.values()) {
    clearTimeout(operation.timer)
    operation.reject(error)
  }
  pending.clear()
}
