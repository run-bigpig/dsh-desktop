import { randomBytes, randomUUID } from 'node:crypto'

import type { WebSocket } from 'ws'

const RPC_TIMEOUT_MS = 120_000

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
}

export function createBrowserSessions() {
  const sessions = new Map<string, BrowserDesignSession>()

  function prepare(sessionId: string): BrowserDesignSession {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const session = {
      id: sessionId,
      token: randomBytes(32).toString('base64url'),
      socket: null,
      pending: new Map<string, PendingRPC>()
    }
    sessions.set(sessionId, session)
    return session
  }

  async function sendRPC(sessionId: string, command: string, args: unknown): Promise<unknown> {
    const session = sessions.get(sessionId)
    const socket = session?.socket
    if (!session || !isOpen(socket)) throw new Error('请先在设计模式中创建或打开文档')
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

  function register(socket: WebSocket, message: Record<string, unknown>): boolean {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : ''
    const token = typeof message.token === 'string' ? message.token : ''
    const session = sessions.get(sessionId)
    if (!session || !safeEqual(token, session.token)) return false
    session.socket?.close(4001, 'session opened in another view')
    session.socket = socket
    socket.send(JSON.stringify({ type: 'registered', sessionId }))
    return true
  }

  function handleMessage(socket: WebSocket, message: Record<string, unknown>): void {
    if (message.type === 'register') {
      if (!register(socket, message)) socket.close(4003, 'invalid design session')
      return
    }
    if (message.type !== 'response' || typeof message.id !== 'string') return
    const session = [...sessions.values()].find(candidate => candidate.socket === socket)
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
