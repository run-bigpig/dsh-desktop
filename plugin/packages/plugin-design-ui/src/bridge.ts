import { renderNodesToImage } from '@open-pencil/core/io'
import { FigmaAPI } from '@open-pencil/core/figma-api'
import { computeAllLayouts } from '@open-pencil/core/layout'
import { ALL_TOOLS } from '@open-pencil/core/tools'

import type { DesignSession } from './runtime.ts'

export function startBridge(session: DesignSession): () => void {
  let stopped = false
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined

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
      void handleMessage(session, current, event.data)
    })
    current.addEventListener('close', event => {
      if (socket === current) socket = undefined
      if (stopped || event.code === 1000) return
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
    socket?.close(1000, 'design view closed')
  }
}

async function handleMessage(session: DesignSession, socket: WebSocket, raw: unknown): Promise<void> {
  let message: Record<string, unknown>
  try { message = JSON.parse(String(raw)) as Record<string, unknown> } catch { return }
  if (message.type === 'registered') {
    session.bridgePhase = 'connected'
    session.bridgeDetail = 'Agent 已连接当前文档'
    return
  }
  if (message.type !== 'request' || typeof message.id !== 'string' || typeof message.command !== 'string') return
  try {
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
  if (!definition) throw new Error(`Unknown OpenPencil tool: ${name}`)
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
  figma.viewport = {
    center: {
      x: (-editor.state.panX + window.innerWidth / 2) / editor.state.zoom,
      y: (-editor.state.panY + window.innerHeight / 2) / editor.state.zoom
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
  const result = await definition.execute(figma, toolArgs)
  if (definition.mutates) {
    computeAllLayouts(editor.graph, pageId)
    editor.requestRender()
  }
  return { ok: true, result }
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
