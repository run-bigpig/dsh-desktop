import { randomBytes, randomUUID } from 'node:crypto'

import type { WebSocket } from 'ws'

const RPC_TIMEOUT_MS = 120_000
const BROWSER_WAIT_MS = 45_000

type PendingRPC = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type PendingWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type DesignSession = {
  id: string
  token: string
  socket: WebSocket | null
  openedAt: number
  pending: Map<string, PendingRPC>
  waiters: Set<PendingWaiter>
}

export function createBrowserSessions(
  openBrowser: (session: DesignSession, navigate: boolean) => Promise<void>
) {
  const sessions = new Map<string, DesignSession>()
  let currentSessionId: string | undefined

  function getOrCreate(requestedId?: string): DesignSession {
    if (requestedId) {
      const existing = sessions.get(requestedId)
      if (existing) return existing
      if (!isUUID(requestedId)) throw new Error('design_session_id must be a UUID')
    }
    const id = requestedId ?? randomUUID()
    const session: DesignSession = {
      id,
      token: randomBytes(32).toString('base64url'),
      socket: null,
      openedAt: 0,
      pending: new Map(),
      waiters: new Set()
    }
    sessions.set(id, session)
    currentSessionId = id
    return session
  }

  function resolveSession(requestedId?: string): DesignSession {
    if (requestedId) return getOrCreate(requestedId)
    if (currentSessionId) {
      const current = sessions.get(currentSessionId)
      if (current) return current
    }
    if (sessions.size === 1) {
      const only = sessions.values().next().value
      if (only) return only
    }
    return getOrCreate()
  }

  async function ensureOpen(requestedId?: string, reveal = false): Promise<DesignSession> {
    const session = resolveSession(requestedId)
    currentSessionId = session.id
    if (reveal || (!isOpen(session.socket) && Date.now() - session.openedAt > 3000)) {
      session.openedAt = Date.now()
      const pageSocket = isOpen(session.socket)
        ? session.socket
        : [...sessions.values()].find(candidate => isOpen(candidate.socket))?.socket
      if (isOpen(session.socket)) {
        session.socket.send(JSON.stringify({ type: 'reveal-session', sessionId: session.id }))
      } else if (isOpen(pageSocket)) {
        pageSocket.send(JSON.stringify({
          type: 'open-session',
          sessionId: session.id,
          token: session.token
        }))
      }
      await openBrowser(session, !isOpen(pageSocket))
    }
    return session
  }

  async function sendRPC(requestedId: string | undefined, command: string, args: unknown): Promise<unknown> {
    const session = await ensureOpen(requestedId)
    if (!isOpen(session.socket)) await waitForBrowser(session)
    const socket = session.socket
    if (!isOpen(socket)) throw new Error('StarWeave Design canvas did not connect')
    return await new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(new Error(`Design RPC timed out after ${RPC_TIMEOUT_MS / 1000}s`))
      }, RPC_TIMEOUT_MS)
      session.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ type: 'request', id, command, args, sessionId: session.id }))
    })
  }

  function register(socket: WebSocket, message: Record<string, unknown>): boolean {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : ''
    const token = typeof message.token === 'string' ? message.token : ''
    const session = sessions.get(sessionId)
    if (!session || !safeEqual(token, session.token)) return false
    session.socket?.close(4001, 'session opened in another browser')
    session.socket = socket
    currentSessionId = session.id
    socket.send(JSON.stringify({ type: 'registered', sessionId }))
    for (const waiter of session.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    session.waiters.clear()
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
      pending.reject(new Error('StarWeave Design browser disconnected'))
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
      for (const pending of session.waiters) {
        clearTimeout(pending.timer)
        pending.reject(new Error('StarWeave Design is shutting down'))
      }
    }
    sessions.clear()
  }

  return { close, disconnect, ensureOpen, handleMessage, sendRPC, prepare: getOrCreate }
}

async function waitForBrowser(session: DesignSession): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.waiters.delete(waiter)
      reject(new Error('Timed out waiting for the StarWeave Design canvas window'))
    }, BROWSER_WAIT_MS)
    const waiter: PendingWaiter = { resolve, reject, timer }
    session.waiters.add(waiter)
    if (isOpen(session.socket)) {
      session.waiters.delete(waiter)
      clearTimeout(timer)
      resolve()
    }
  })
}

function isOpen(socket: WebSocket | null | undefined): socket is WebSocket {
  return socket !== null && socket !== undefined && socket.readyState === socket.OPEN
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let result = 0
  for (let index = 0; index < left.length; index++) result |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return result === 0
}

export type BrowserDesignSession = DesignSession
