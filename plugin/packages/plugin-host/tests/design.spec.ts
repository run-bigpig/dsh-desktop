import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebSocket } from 'ws'

import { createBrowserSessions } from '../src/design/browser-sessions.ts'
import { createDesignMCPSessions } from '../src/design/mcp-sessions.ts'
import { startDesignServer, type DesignServer } from '../src/design/server.ts'
import { registerDesignTools } from '../src/design/tools.ts'

const activeServers: DesignServer[] = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(server => server.close()))
})

describe('StarWeave Design browser sessions', () => {
  it('requires the user canvas to connect before an Agent can call it', async () => {
    const sessions = createBrowserSessions()
    sessions.prepare('session-a')
    await expect(sessions.sendRPC('session-a', 'list_documents', {}))
      .rejects.toThrow('请先在设计模式中创建或打开文档')
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

    sessions.handleMessage(socket, { type: 'register', sessionId: first.id, token: first.token })
    const pending = sessions.sendRPC(first.id, 'tool', { name: 'get_selection' })
    const request = JSON.parse(String(send.mock.calls[1]?.[0])) as { id: string; sessionId: string }
    expect(request.sessionId).toBe('session-a')
    await expect(sessions.sendRPC('session-b', 'list_documents', {}))
      .rejects.toThrow('请先在设计模式中创建或打开文档')

    sessions.handleMessage(socket, { type: 'response', id: request.id, ok: true, result: { selection: [] } })
    await expect(pending).resolves.toMatchObject({ ok: true, result: { selection: [] } })
    sessions.close()
  })
})

describe('StarWeave Design MCP tools', () => {
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
    expect(result.content?.[0]?.text).toContain('请先在设计模式中创建或打开文档')
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
