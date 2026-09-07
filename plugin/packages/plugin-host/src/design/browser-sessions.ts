import { randomBytes, randomUUID } from 'node:crypto'

import type { WebSocket } from 'ws'

import { isStoredDocument, type DesignDocumentStore } from './storage.ts'

const RPC_TIMEOUT_MS = 120_000

export type DesignDocumentStoreResolver = () => Promise<DesignDocumentStore | undefined>

type PendingRPC = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type BrowserDesignSession = {
  id: string
  token: string
  socket: WebSocket | null
  pending: Map<string, PendingRPC>
  ready: boolean
  store: DesignDocumentStore | undefined
  resolveStore: DesignDocumentStoreResolver | undefined
  saves: Promise<void>
}

export function createBrowserSessions() {
  const sessions = new Map<string, BrowserDesignSession>()

  function prepare(sessionId: string, resolveStore?: DesignDocumentStoreResolver): BrowserDesignSession {
    const existing = sessions.get(sessionId)
    if (existing) {
      if (resolveStore) existing.resolveStore = resolveStore
      return existing
    }
    const session = {
      id: sessionId,
      token: randomBytes(32).toString('base64url'),
      socket: null,
      pending: new Map<string, PendingRPC>(),
      ready: false,
      store: undefined,
      resolveStore,
      saves: Promise.resolve()
    }
    sessions.set(sessionId, session)
    return session
  }

  async function sendRPC(sessionId: string, command: string, args: unknown): Promise<unknown> {
    const session = sessions.get(sessionId)
    const socket = session?.socket
    if (!session || !session.ready || !isOpen(socket)) throw new Error('请先在设计模式中创建或打开文档')
    return await new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(new Error(`Design RPC timed out after ${RPC_TIMEOUT_MS / 1000}s`))
      }, RPC_TIMEOUT_MS)
      session.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ type: 'request', id, command, args, sessionId }))
    })
  }

  async function register(socket: WebSocket, message: Record<string, unknown>): Promise<boolean> {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : ''
    const token = typeof message.token === 'string' ? message.token : ''
    const session = sessions.get(sessionId)
    if (!session || !safeEqual(token, session.token)) return false
    session.socket?.close(4001, 'session opened in another view')
    session.socket = socket
    session.ready = false
    let document
    let restoreError: string | undefined
    try {
      await session.saves
      session.store ??= await session.resolveStore?.()
      if (!session.store && session.resolveStore) {
        restoreError = 'StarWeave Design persistence directory is not available for this session'
      }
      document = await session.store?.load()
    } catch (error) {
      restoreError = error instanceof Error ? error.message : String(error)
    }
    if (session.socket !== socket) return false
    socket.send(JSON.stringify({
      type: 'registered',
      sessionId,
      persistence: session.store !== undefined,
      document,
      restoreError
    }))
    session.ready = restoreError === undefined
    return true
  }

  async function handleMessage(socket: WebSocket, message: Record<string, unknown>): Promise<void> {
    if (message.type === 'register') {
      if (!await register(socket, message)) socket.close(4003, 'invalid design session')
      return
    }
    const session = [...sessions.values()].find(candidate => candidate.socket === socket)
    if (message.type === 'persist_document' && typeof message.id === 'string') {
      if (!session?.store || !isStoredDocument(message.document)) {
        socket.send(JSON.stringify({
          type: 'persistence_error',
          id: message.id,
          error: 'Design session document is invalid or storage is unavailable'
        }))
        return
      }
      const document = message.document
      session.saves = session.saves.then(() => session.store!.save(document))
      try {
        await session.saves
        if (session.socket === socket) socket.send(JSON.stringify({ type: 'persisted', id: message.id }))
      } catch (error) {
        session.saves = Promise.resolve()
        if (session.socket === socket) socket.send(JSON.stringify({
          type: 'persistence_error',
          id: message.id,
          error: error instanceof Error ? error.message : String(error)
        }))
      }
      return
    }
    if (message.type !== 'response' || typeof message.id !== 'string') return
    const pending = session?.pending.get(message.id)
    if (!session || !pending) return
    session.pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.resolve(message)
  }

  function disconnect(socket: WebSocket): void {
    const session = [...sessions.values()].find(candidate => candidate.socket === socket)
    if (!session) return
    session.socket = null
    session.ready = false
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('StarWeave Design canvas disconnected'))
    }
    session.pending.clear()
  }

  function close(): void {
    for (const session of sessions.values()) {
      session.socket?.close(1001, 'StarWeave is shutting down')
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('StarWeave Design is shutting down'))
      }
    }
    sessions.clear()
  }

  return { close, disconnect, handleMessage, prepare, sendRPC }
}

function isOpen(socket: WebSocket | null | undefined): socket is WebSocket {
  return socket !== null && socket !== undefined && socket.readyState === socket.OPEN
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let result = 0
  for (let index = 0; index < left.length; index++) result |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return result === 0
}
