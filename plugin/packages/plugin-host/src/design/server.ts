import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, stat } from 'node:fs/promises'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebSocketServer } from 'ws'

import { createBrowserSessions } from './browser-sessions.ts'
import { createDesignMCPSessions } from './mcp-sessions.ts'
import { registerDesignTools } from './tools.ts'
import type { DesignConnection } from '../shared/types.ts'

const MAX_HTTP_BODY = 2 * 1024 * 1024
const UI_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  import.meta.url.endsWith('.ts') ? '../../web/starweave-design' : '../web/starweave-design'
)

export type DesignOwner = { id: string }

export type DesignServer = {
  port: number
  authToken: string
  connection: (sessionId: string) => DesignConnection
  registerOwner: (owner: DesignOwner) => { token: string; dispose: () => void }
  close: () => Promise<void>
}

export async function startDesignServer(authToken: string): Promise<DesignServer> {
  let port = 0
  const browsers = createBrowserSessions()
  const owners = new Map<string, DesignOwner>()
  const mcpSessions = createDesignMCPSessions((server: McpServer, ownerToken?: string) => {
    registerDesignTools(server, browsers.sendRPC, ownerToken ? owners.get(ownerToken)?.id : undefined)
  })
  const designSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  const httpServer = createServer((request, response) => {
    void handleHTTP(request, response, authToken, mcpSessions, owners).catch(error => {
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
    if (target.pathname !== '/bridge' || !isLoopback(request.socket.remoteAddress ?? '') || !isLoopbackOrigin(request.headers.origin)) {
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
  })

  await new Promise<void>((accept, reject) => {
    const failed = (error: Error) => reject(error)
    httpServer.once('error', failed)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', failed)
      accept()
    })
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('StarWeave Design server has no TCP port')
  port = address.port
  const baseUrl = `http://127.0.0.1:${port}/`

  return {
    port,
    authToken,
    connection: sessionId => {
      const session = browsers.prepare(sessionId)
      return {
        baseUrl,
        sessionId: session.id,
        token: session.token,
        scriptPath: 'starweave-design-embed.js',
        stylePath: 'starweave-design-embed.css'
      }
    },
    registerOwner: owner => {
      browsers.prepare(owner.id)
      const token = randomBytes(32).toString('base64url')
      owners.set(token, owner)
      return { token, dispose: () => { owners.delete(token) } }
    },
    close: async () => {
      owners.clear()
      browsers.close()
      await mcpSessions.clear()
      for (const client of designSockets.clients) client.terminate()
      await Promise.all([
        closeWebSocketServer(designSockets),
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
  owners: Map<string, DesignOwner>
): Promise<void> {
  const target = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  if (!isLoopback(request.socket.remoteAddress ?? '')) return writeJSON(response, 403, { error: 'loopback only' })
  if (target.pathname === '/health') return writeJSON(response, 200, { status: 'ok' })
  if (target.pathname === '/mcp') {
    if (!authorized(request, authToken)) return writeJSON(response, 401, { error: 'unauthorized' })
    const sessionId = header(request, 'mcp-session-id')
    const owner = header(request, 'x-starweave-owner')
    if (!owner || !owners.has(owner)) return writeJSON(response, 403, { error: 'design owner expired' })
    if (request.method === 'DELETE' && !sessionId) return writeJSON(response, 400, { error: 'missing MCP session id' })
    let transport
    try {
      transport = await sessions.resolve(sessionId, owner)
    } catch (error) {
      return writeJSON(response, sessionId ? 404 : 503, { error: describeError(error) })
    }
    const webResponse = await transport.handleRequest(await toWebRequest(request, target))
    await writeWebResponse(response, webResponse)
    if (request.method === 'DELETE' && sessionId) await sessions.remove(sessionId)
    return
  }
  await serveStatic(target.pathname, request, response)
}

async function serveStatic(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return writeJSON(response, 405, { error: 'method not allowed' })
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { return writeJSON(response, 400, { error: 'invalid path' }) }
  const relative = decoded.replace(/^\/+/, '')
  if (!relative || !extname(relative)) return writeJSON(response, 404, { error: 'not found' })
  const filename = resolve(UI_ROOT, relative)
  if (filename !== UI_ROOT && !filename.startsWith(`${UI_ROOT}${sep}`)) return writeJSON(response, 404, { error: 'not found' })
  let content: Buffer
  try {
    if (!(await stat(filename)).isFile()) throw new Error('not a file')
    content = await readFile(filename)
  } catch {
    return writeJSON(response, 404, { error: 'not found' })
  }
  response.statusCode = 200
  response.setHeader('Content-Type', mimeType(filename))
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  response.end(request.method === 'HEAD' ? undefined : content)
}

async function toWebRequest(request: IncomingMessage, target: URL): Promise<Request> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  const method = request.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request)
  return new Request(target, { method, headers, ...(body === undefined ? {} : { body }) })
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

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && isLoopback(url.hostname)
  } catch { return false }
}

function rejectUpgrade(socket: { write: (value: string) => unknown; destroy: () => unknown }): void {
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  socket.destroy()
}

function isLoopback(value: string): boolean {
  const address = value.toLowerCase().replace(/^::ffff:/u, '')
  return address === 'localhost' || address === '::1' || address.startsWith('127.')
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

function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
