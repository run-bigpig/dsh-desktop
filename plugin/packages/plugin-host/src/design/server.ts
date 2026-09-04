import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { basename, dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, stat } from 'node:fs/promises'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebSocket, WebSocketServer } from 'ws'

import { desktopRequest } from '../desktop/index.ts'
import { createBrowserSessions, type BrowserDesignSession } from './browser-sessions.ts'
import { createDesignMCPSessions } from './mcp-sessions.ts'
import { createNativeDesignSave } from './native-save.ts'
import { createDesignSaveUploads } from './save-uploads.ts'
import { createDesignSessionFiles } from './session-files.ts'
import { registerDesignTools } from './tools.ts'

const MAX_HTTP_BODY = 2 * 1024 * 1024
const MAX_COLLAB_MESSAGE = 64 * 1024 * 1024
const UI_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  import.meta.url.endsWith('.ts') ? '../../web/starweave-ui' : '../web/starweave-ui'
)

export type DesignServer = {
  port: number
  authToken: string
  close: () => Promise<void>
}

export async function startDesignServer(authToken: string): Promise<DesignServer> {
  let port = 0
  const lanAddresses = privateIPv4Addresses()
  const openBrowser = async (session: BrowserDesignSession, navigate: boolean): Promise<void> => {
    if (port < 1) throw new Error('StarWeave Design server is not ready')
    const target = new URL(`http://127.0.0.1:${port}/`)
    target.searchParams.set('session', session.id)
    target.searchParams.set('token', session.token)
    if (lanAddresses[0]) target.searchParams.set('lan', `http://${lanAddresses[0]}:${port}`)
    await desktopRequest('/v1/design/open', {
      method: 'POST',
      body: JSON.stringify({ url: target.href, navigate })
    })
  }
  const browsers = createBrowserSessions(openBrowser)
  const uploads = createDesignSaveUploads()
  const sessionFiles = createDesignSessionFiles()
  const saveFile = createNativeDesignSave({
    sendRPC: browsers.sendRPC,
    choosePath: async suggestedName => await desktopRequest('/v1/design/save-path', {
      method: 'POST',
      body: JSON.stringify({ suggestedName }),
      signal: AbortSignal.timeout(5 * 60_000)
    }),
    createUpload: uploads.create,
    loadPath: sessionFiles.get,
    storePath: sessionFiles.set
  })
  const openFile = async (sessionId: string): Promise<unknown> => {
    const selected = await desktopRequest<{ path?: string; cancelled?: boolean }>('/v1/design/open-path', {
      method: 'POST',
      signal: AbortSignal.timeout(5 * 60_000)
    })
    if (selected.cancelled || !selected.path) throw new Error('Open cancelled by user')
    const result = await browsers.sendRPC(sessionId, 'open_file', {
      name: basename(selected.path),
      starweave_download_url: uploads.createDownload(selected.path)
    })
    if (!resultDocumentId(result)) throw new Error('StarWeave Design did not open the selected file')
    await sessionFiles.set(sessionId, selected.path)
    return result
  }
  const restoreDocument = async (sessionId: string): Promise<string | undefined> => {
    const path = await sessionFiles.get(sessionId)
    if (!path) return undefined
    const result = await browsers.sendRPC(sessionId, 'open_file', {
      name: basename(path),
      starweave_download_url: uploads.createDownload(path)
    })
    return resultDocumentId(result)
  }
  const mcpSessions = createDesignMCPSessions((server: McpServer) => {
    registerDesignTools(
      server,
      browsers.sendRPC,
      async (requestedId, reveal) => {
        const session = await browsers.ensureOpen(requestedId, reveal)
        return { id: session.id, connected: session.socket?.readyState === session.socket?.OPEN }
      },
      saveFile,
      openFile,
      restoreDocument
    )
  })

  const designSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  const collaborationSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_COLLAB_MESSAGE })
  const collaboration = createCollaborationRelay()
  const httpServer = createServer((request, response) => {
    void handleHTTP(request, response, authToken, mcpSessions, uploads, port).catch(error => {
      if (!response.headersSent) writeJSON(response, 500, { error: describeError(error) })
      else response.destroy(error instanceof Error ? error : undefined)
    })
  })

  httpServer.on('upgrade', (request, socket, head) => {
    let target: URL
    try {
      target = new URL(request.url ?? '/', 'http://localhost')
    } catch {
      rejectUpgrade(socket)
      return
    }
    if (target.pathname === '/bridge') {
      if (!isLoopback(request.socket.remoteAddress ?? '') || !validBrowserOrigin(request.headers.origin, port)) {
        rejectUpgrade(socket)
        return
      }
      designSockets.handleUpgrade(request, socket, head, client => {
        client.on('message', raw => {
          try {
            const value = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as unknown
            if (isRecord(value)) browsers.handleMessage(client, value)
          } catch {
            client.close(1007, 'invalid JSON')
          }
        })
        client.once('close', () => browsers.disconnect(client))
      })
      return
    }

    const roomId = collaborationRoom(target.pathname)
    if (
      !roomId ||
      !isPrivateNetworkAddress(request.socket.remoteAddress ?? '') ||
      !validCollaborationOrigin(request.headers.origin, port)
    ) {
      rejectUpgrade(socket)
      return
    }
    collaborationSockets.handleUpgrade(request, socket, head, client => collaboration.accept(client, roomId))
  })

  await new Promise<void>((accept, reject) => {
    const failed = (error: Error) => reject(error)
    httpServer.once('error', failed)
    httpServer.listen(0, '0.0.0.0', () => {
      httpServer.off('error', failed)
      accept()
    })
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('StarWeave Design server has no TCP port')
  port = address.port

  return {
    port,
    authToken,
    close: async () => {
      browsers.close()
      uploads.clear()
      collaboration.close()
      await mcpSessions.clear()
      for (const client of designSockets.clients) client.terminate()
      for (const client of collaborationSockets.clients) client.terminate()
      await Promise.all([
        closeWebSocketServer(designSockets),
        closeWebSocketServer(collaborationSockets),
        new Promise<void>(accept => httpServer.close(() => accept()))
      ])
    }
  }
}

async function handleHTTP(
  request: IncomingMessage,
  response: ServerResponse,
  authToken: string,
  sessions: ReturnType<typeof createDesignMCPSessions>,
  uploads: ReturnType<typeof createDesignSaveUploads>,
  port: number
): Promise<void> {
  const target = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const saveToken = /^\/design-save\/([-_A-Za-z0-9]{43})$/u.exec(target.pathname)?.[1]
  if (saveToken) {
    if (!isLoopback(request.socket.remoteAddress ?? '') || !validBrowserOrigin(request.headers.origin, port)) {
      return writeJSON(response, 403, { error: 'forbidden' })
    }
    await uploads.handle(request, response, saveToken)
    return
  }
  const openToken = /^\/design-open\/([-_A-Za-z0-9]{43})$/u.exec(target.pathname)?.[1]
  if (openToken) {
    if (!isLoopback(request.socket.remoteAddress ?? '') || !validBrowserOrigin(request.headers.origin, port)) {
      return writeJSON(response, 403, { error: 'forbidden' })
    }
    await uploads.handleDownload(request, response, openToken)
    return
  }
  if (target.pathname === '/health') {
    if (!isLoopback(request.socket.remoteAddress ?? '')) return writeJSON(response, 403, { error: 'forbidden' })
    return writeJSON(response, 200, { status: 'ok' })
  }
  if (target.pathname === '/mcp') {
    if (!isLoopback(request.socket.remoteAddress ?? '') || !authorized(request, authToken)) {
      return writeJSON(response, 401, { error: 'unauthorized' })
    }
    const sessionId = header(request, 'mcp-session-id')
    if (request.method === 'DELETE' && !sessionId) return writeJSON(response, 400, { error: 'missing MCP session id' })
    let transport
    try {
      transport = await sessions.resolve(sessionId)
    } catch (error) {
      return writeJSON(response, sessionId ? 404 : 503, { error: describeError(error) })
    }
    const webRequest = await toWebRequest(request, target)
    const webResponse = await transport.handleRequest(webRequest)
    await writeWebResponse(response, webResponse)
    if (request.method === 'DELETE' && sessionId) await sessions.remove(sessionId)
    return
  }
  if (!isPrivateNetworkAddress(request.socket.remoteAddress ?? '')) {
    return writeJSON(response, 403, { error: 'LAN access only' })
  }
  await serveStatic(target.pathname, request, response)
}

async function serveStatic(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return writeJSON(response, 405, { error: 'method not allowed' })
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return writeJSON(response, 400, { error: 'invalid path' })
  }
  const relative = decoded === '/' || !extname(decoded) ? 'index.html' : decoded.replace(/^\/+/, '')
  const filename = resolve(UI_ROOT, relative)
  if (filename !== UI_ROOT && !filename.startsWith(`${UI_ROOT}${sep}`)) return writeJSON(response, 404, { error: 'not found' })
  let content: Buffer
  try {
    if (!(await stat(filename)).isFile()) throw new Error('not a file')
    content = await readFile(filename)
  } catch {
    if (relative !== 'index.html') return writeJSON(response, 404, { error: 'not found' })
    content = await readFile(resolve(UI_ROOT, 'index.html'))
  }
  response.statusCode = 200
  response.setHeader('Content-Type', mimeType(filename))
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cache-Control', relative === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable')
  response.end(request.method === 'HEAD' ? undefined : content)
}

function createCollaborationRelay() {
  const rooms = new Map<string, Map<WebSocket, string>>()
  function accept(socket: WebSocket, roomId: string): void {
    const room = rooms.get(roomId) ?? new Map<WebSocket, string>()
    rooms.set(roomId, room)
    const peerId = randomUUID()
    const peers = [...room.values()]
    room.set(socket, peerId)
    socket.send(JSON.stringify({ type: 'welcome', peerId, peers }))
    for (const peer of room.keys()) if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'peer-join', peerId }))

    socket.on('message', (data, binary) => {
      const source = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (!binary || source.length < 3 || source[0] !== 1) return socket.close(1008, 'binary collaboration messages only')
      const namespaceLength = source[1] ?? 0
      const targetLength = source[2] ?? 0
      const targetStart = 3 + namespaceLength
      const payloadStart = targetStart + targetLength
      if (payloadStart > source.length) return socket.close(1007, 'invalid collaboration message')
      const target = source.subarray(targetStart, payloadStart).toString('utf8')
      const sender = Buffer.from(peerId, 'utf8')
      const outgoing = Buffer.concat([
        source.subarray(0, 2),
        Buffer.from([sender.length]),
        source.subarray(3, targetStart),
        sender,
        source.subarray(payloadStart)
      ])
      for (const [peer, id] of room) {
        if (peer === socket || peer.readyState !== WebSocket.OPEN || (target && target !== id)) continue
        peer.send(outgoing, { binary: true })
      }
    })
    socket.once('close', () => {
      room.delete(socket)
      for (const peer of room.keys()) if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'peer-leave', peerId }))
      if (room.size === 0) rooms.delete(roomId)
    })
  }
  return {
    accept,
    close: () => {
      for (const room of rooms.values()) for (const socket of room.keys()) socket.terminate()
      rooms.clear()
    }
  }
}

async function toWebRequest(request: IncomingMessage, target: URL): Promise<Request> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  const method = request.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request)
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = body
  return new Request(target, init)
}

async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array)
    length += buffer.length
    if (length > MAX_HTTP_BODY) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const combined = Buffer.concat(chunks)
  const body = new Uint8Array(combined.byteLength)
  body.set(combined)
  return body
}

async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status
  webResponse.headers.forEach((value, name) => response.setHeader(name, value))
  response.end(Buffer.from(await webResponse.arrayBuffer()))
}

function writeJSON(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(JSON.stringify(value))
}

function authorized(request: IncomingMessage, token: string): boolean {
  return header(request, 'authorization') === `Bearer ${token}` || header(request, 'x-mcp-token') === token
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function validBrowserOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}`
}

function validCollaborationOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false
  try {
    const target = new URL(origin)
    return target.protocol === 'http:' && target.port === String(port) && isPrivateNetworkAddress(target.hostname)
  } catch {
    return false
  }
}

function collaborationRoom(pathname: string): string | null {
  const match = /^\/collaboration\/([a-z0-9]{24})$/u.exec(pathname)
  return match?.[1] ?? null
}

function rejectUpgrade(socket: { write: (value: string) => unknown; destroy: () => unknown }): void {
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  socket.destroy()
}

function privateIPv4Addresses(): string[] {
  const values: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4' && isPrivateNetworkAddress(entry.address)) values.push(entry.address)
    }
  }
  return [...new Set(values)].sort()
}

function isPrivateNetworkAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^::ffff:/u, '')
  if (isLoopback(address)) return true
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [first, second] = octets
  return first === 10 || (first === 172 && second !== undefined && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254) || (first === 100 && second !== undefined && second >= 64 && second <= 127)
}

function isLoopback(value: string): boolean {
  const address = value.toLowerCase().replace(/^::ffff:/u, '')
  return address === '::1' || address.startsWith('127.')
}

function mimeType(filename: string): string {
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json'
  } as Record<string, string>)[extname(filename)] ?? 'application/octet-stream'
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise(resolveClose => server.close(() => resolveClose()))
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resultDocumentId(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.target)) return undefined
  return typeof value.target.documentId === 'string' ? value.target.documentId : undefined
}
