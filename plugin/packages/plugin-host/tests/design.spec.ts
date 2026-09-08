import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ALL_TOOLS } from '@open-pencil/core/tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

import { createBrowserSessions } from '../src/design/browser-sessions.ts'
import { createDesignMCPSessions } from '../src/design/mcp-sessions.ts'
import { startDesignServer, type DesignServer } from '../src/design/server.ts'
import { createDesignDocumentStore } from '../src/design/storage.ts'
import { registerDesignTools } from '../src/design/tools.ts'

const activeServers: DesignServer[] = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(server => server.close()))
})

describe('StarWeave Design browser sessions', () => {
  it('keeps the current owner connected and lets a waiting window restore after it exits', async () => {
    const sessions = createBrowserSessions()
    const load = vi.fn(async () => ({ name: 'Saved.fig', data: 'AQIDBA==' }))
    const session = sessions.prepare('session-a', async () => ({ load, save: vi.fn() }))
    const owner = mockSocket()
    const waiting = mockSocket()
    const registration = { type: 'register', sessionId: session.id, token: session.token }
    try {
      await sessions.handleMessage(owner.socket, registration)
      await sessions.handleMessage(waiting.socket, registration)
      expect(owner.socket.close).not.toHaveBeenCalled()
      expect(waiting.socket.close).toHaveBeenCalledWith(4001, 'session already open in another view')
      expect(sessions.isReady(session.id)).toBe(true)
      expect(load).toHaveBeenCalledTimes(1)
      sessions.disconnect(waiting.socket)
      const pending = sessions.sendRPC(session.id, 'get_selection', {})
      const request = JSON.parse(String(owner.send.mock.calls.at(-1)?.[0]))
      await sessions.handleMessage(owner.socket, { type: 'response', id: request.id, ok: true })
      await expect(pending).resolves.toMatchObject({ ok: true })
      sessions.disconnect(owner.socket)
      const next = mockSocket()
      await sessions.handleMessage(next.socket, registration)
      expect(load).toHaveBeenCalledTimes(2)
      expect(sessions.isReady(session.id)).toBe(true)
      expect(JSON.parse(String(next.send.mock.calls[0]?.[0]))).toMatchObject({
        type: 'registered', document: { name: 'Saved.fig', data: 'AQIDBA==' }
      })
    } finally { sessions.close() }
  })

  it('requires the user canvas to connect before an Agent can call it', async () => {
    const sessions = createBrowserSessions()
    sessions.prepare('session-a')
    await expect(sessions.sendRPC('session-a', 'list_documents', {}))
      .rejects.toThrow('当前会话画布尚未连接，请调用 open_canvas 并等待初始化')
    sessions.close()
  })

  it('routes requests only to the matching authenticated session', async () => {
    const sessions = createBrowserSessions()
    const first = sessions.prepare('session-a')
    sessions.prepare('session-b')
    const send = vi.fn()
    const socket = {
      OPEN: WebSocket.OPEN,
      readyState: WebSocket.OPEN,
      send,
      close: vi.fn()
    } as unknown as WebSocket

    await sessions.handleMessage(socket, { type: 'register', sessionId: first.id, token: first.token })
    const pending = sessions.sendRPC(first.id, 'tool', { name: 'get_selection' })
    const request = JSON.parse(String(send.mock.calls[1]?.[0])) as { id: string; sessionId: string }
    expect(request.sessionId).toBe('session-a')
    await expect(sessions.sendRPC('session-b', 'list_documents', {}))
      .rejects.toThrow('当前会话画布尚未连接，请调用 open_canvas 并等待初始化')

    await sessions.handleMessage(socket, { type: 'response', id: request.id, ok: true, result: { selection: [] } })
    await expect(pending).resolves.toMatchObject({ ok: true, result: { selection: [] } })
    sessions.close()
  })

  it('restores only the matching session document after the browser session is recreated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starweave-design-'))
    try {
      const filename = join(root, 'session-a', 'starweave-design.json')
      const firstSessions = createBrowserSessions()
      const first = firstSessions.prepare('session-a', async () => createDesignDocumentStore(filename))
      const firstSocket = mockSocket()
      await firstSessions.handleMessage(firstSocket.socket, {
        type: 'register', sessionId: first.id, token: first.token
      })
      await firstSessions.handleMessage(firstSocket.socket, {
        type: 'persist_document',
        id: 'save-1',
        document: { name: 'Landing.fig', data: 'AQIDBA==' }
      })
      expect(JSON.parse(String(firstSocket.send.mock.calls.at(-1)?.[0])))
        .toMatchObject({ type: 'persisted', id: 'save-1' })
      firstSessions.close()

      const restoredSessions = createBrowserSessions()
      const resolveStore = vi.fn(async () => createDesignDocumentStore(filename))
      const restored = restoredSessions.prepare('session-a', resolveStore)
      expect(resolveStore).not.toHaveBeenCalled()
      const restoredSocket = mockSocket()
      await restoredSessions.handleMessage(restoredSocket.socket, {
        type: 'register', sessionId: restored.id, token: restored.token
      })
      expect(JSON.parse(String(restoredSocket.send.mock.calls[0]?.[0]))).toMatchObject({
        type: 'registered',
        sessionId: 'session-a',
        persistence: true,
        document: { name: 'Landing.fig', data: 'AQIDBA==' }
      })
      expect(resolveStore).toHaveBeenCalledOnce()

      const otherSessions = createBrowserSessions()
      const other = otherSessions.prepare(
        'session-b',
        async () => createDesignDocumentStore(join(root, 'session-b', 'starweave-design.json'))
      )
      const otherSocket = mockSocket()
      await otherSessions.handleMessage(otherSocket.socket, {
        type: 'register', sessionId: other.id, token: other.token
      })
      expect(JSON.parse(String(otherSocket.send.mock.calls[0]?.[0]))).not.toHaveProperty('document')
      restoredSessions.close()
      otherSessions.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('StarWeave Design MCP tools', () => {
  it('routes shared style operations through the current session', async () => {
    const callbacks = toolCallbacks()
    const sendRPC = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: { documents: [{ id: 'design-session', active: true }] } })
      .mockResolvedValueOnce({ ok: true, result: { style_id: '0:10' } })
    registerDesignTools(callbacks.server, sendRPC, 'design-session')
    const args = { action: 'create', kind: 'fill', node_id: '0:3', name: 'Brand' }
    await callbacks.get('shared_style')?.(args)
    expect(sendRPC).toHaveBeenLastCalledWith('design-session', 'shared_style', args)
  })

  it('returns PDF exports as MCP resources while preserving image exports', async () => {
    const callbacks = toolCallbacks()
    const sendRPC = vi.fn(async (_session: string, command: string, args: any) => command === 'list_documents'
      ? { ok: true, result: { documents: [{ id: 'design-session', active: true }] } }
      : { ok: true, result: { base64: 'AQIDBA==', mimeType: args.name === 'export_pdf' ? 'application/pdf' : 'image/png' } })
    registerDesignTools(callbacks.server, sendRPC, 'design-session')
    expect(await callbacks.get('export_pdf')?.({})).toMatchObject({ content: [{
      type: 'resource', resource: { mimeType: 'application/pdf', blob: 'AQIDBA==' }
    }] })
    expect(await callbacks.get('export_image')?.({})).toMatchObject({ content: [{
      type: 'image', mimeType: 'image/png', data: 'AQIDBA=='
    }] })
  })

  it('exposes every official non-eval canvas tool and session-scoped history commands', () => {
    const callbacks = toolCallbacks()
    registerDesignTools(callbacks.server, vi.fn(), 'design-session')
    expect([...callbacks.keys()].sort()).toEqual([
      ...ALL_TOOLS.filter(tool => tool.name !== 'eval').map(tool => tool.name),
      'list_documents', 'get_codegen_prompt', 'undo', 'redo', 'shared_style'
    ].sort())
  })

  it('does not expose file lifecycle or eval tools to the Agent', () => {
    const callbacks = toolCallbacks()
    registerDesignTools(callbacks.server, vi.fn(), 'design-session')

    expect([...callbacks.keys()]).toContain('list_documents')
    expect([...callbacks.keys()]).toContain('get_selection')
    expect([...callbacks.keys()]).not.toContain('open_file')
    expect([...callbacks.keys()]).not.toContain('new_document')
    expect([...callbacks.keys()]).not.toContain('save_file')
    expect([...callbacks.keys()]).not.toContain('eval')
  })

  it('overrides a requested document id with the current Harness session document', async () => {
    const callbacks = toolCallbacks()
    const sendRPC = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { documents: [{ id: 'design-session', name: 'Current.fig', active: true }] }
      })
      .mockResolvedValueOnce({ ok: true, result: { selection: [] } })
    registerDesignTools(callbacks.server, sendRPC, 'design-session')

    await callbacks.get('get_selection')?.({ document_id: 'another-session', page_id: 'page-1' })

    expect(sendRPC).toHaveBeenNthCalledWith(1, 'design-session', 'list_documents', {})
    expect(sendRPC).toHaveBeenNthCalledWith(2, 'design-session', 'tool', {
      document_id: 'design-session',
      page_id: 'page-1',
      name: 'get_selection',
      args: {}
    })
  })

  it('returns a useful error until exactly one current document is available', async () => {
    const callbacks = toolCallbacks()
    registerDesignTools(callbacks.server, vi.fn().mockResolvedValue({ ok: true, result: { documents: [] } }), 'design-session')

    const result = await callbacks.get('get_selection')?.({}) as { isError?: boolean; content?: Array<{ text?: string }> }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('当前会话画布尚未连接，请调用 open_canvas 并等待初始化')
  })
})

describe('StarWeave Design MCP sessions', () => {
  it('does not allow a different Agent owner to reuse an initialized MCP session', async () => {
    const sessions = createDesignMCPSessions(() => undefined)
    try {
      const transport = await sessions.resolve(undefined, 'owner-a')
      const response = await transport.handleRequest(initializeRequest())
      const id = response.headers.get('mcp-session-id')
      expect(id).toBeTruthy()
      await expect(sessions.resolve(id ?? undefined, 'owner-a')).resolves.toBe(transport)
      await expect(sessions.resolve(id ?? undefined, 'owner-b')).rejects.toThrow('not found')
      await expect(sessions.resolve(id ?? undefined)).rejects.toThrow('not found')
    } finally {
      await sessions.clear()
    }
  })
})

describe('StarWeave Design local server', () => {
  it('reports a persistence restore failure immediately instead of waiting for initialization timeout', async () => {
    const server = await startDesignServer('test-token', undefined, async () => ({
      load: async () => { throw new Error('Saved design is unavailable') }, save: vi.fn()
    }))
    activeServers.push(server)
    const connection = server.connection('restore-error')
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/bridge`, { origin: connection.baseUrl })
    const registered = new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.once('open', () => socket.send(JSON.stringify({ type: 'register', sessionId: connection.sessionId, token: connection.token })))
      socket.once('message', () => resolve())
    })
    try {
      await registered
      await expect(server.waitForReady(connection.sessionId, AbortSignal.timeout(1000)))
        .rejects.toThrow('当前会话画布恢复失败：Saved design is unavailable')
    } finally { socket.close() }
  })

  it('publishes session-scoped canvas credentials on loopback only', async () => {
    const server = await startDesignServer('test-token')
    activeServers.push(server)
    const origin = `http://127.0.0.1:${server.port}`
    const first = server.connection('session-a')
    const second = server.connection('session-b')

    expect(first).toMatchObject({
      baseUrl: `${origin}/`,
      sessionId: 'session-a',
      scriptPath: 'starweave-design-embed.js',
      stylePath: 'starweave-design-embed.css'
    })
    expect(second.token).not.toBe(first.token)
    await expect(fetch(`${origin}/health`)).resolves.toMatchObject({ status: 200 })
    await expect(fetch(`${origin}/mcp`)).resolves.toMatchObject({ status: 401 })
    await expect(fetch(`${origin}/mcp`, { headers: { Authorization: 'Bearer test-token' } }))
      .resolves.toMatchObject({ status: 403 })
    await expect(rejectedUpgrade(`${origin.replace('http:', 'ws:')}/bridge`, 'https://example.com'))
      .resolves.toBe(403)
  })
})

function toolCallbacks(): Map<string, (args: Record<string, unknown>) => Promise<unknown>> & { server: McpServer } {
  const callbacks = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>() as Map<string, (args: Record<string, unknown>) => Promise<unknown>> & { server: McpServer }
  callbacks.server = {
    registerTool(name: string, _options: unknown, callback: (args: Record<string, unknown>) => Promise<unknown>) {
      callbacks.set(name, callback)
    }
  } as unknown as McpServer
  return callbacks
}

function initializeRequest(): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    })
  })
}

function mockSocket(): { socket: WebSocket; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return {
    send,
    socket: {
      OPEN: WebSocket.OPEN,
      readyState: WebSocket.OPEN,
      send,
      close: vi.fn()
    } as unknown as WebSocket
  }
}

function rejectedUpgrade(url: string, origin: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const socket = new WebSocket(url, { origin })
    socket.once('unexpected-response', (_request, response) => {
      resolveStatus(response.statusCode ?? 0)
      socket.terminate()
    })
    socket.once('open', () => {
      socket.terminate()
      reject(new Error('WebSocket upgrade unexpectedly succeeded'))
    })
    socket.once('error', reject)
  })
}
