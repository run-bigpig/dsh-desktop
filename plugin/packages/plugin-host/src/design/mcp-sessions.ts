import { randomUUID } from 'node:crypto'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

type MCPTransport = {
  handleRequest: (request: Request) => Promise<Response>
  close: () => Promise<void>
}

type MCPSession = {
  transport: MCPTransport
  server: McpServer
}

export function createDesignMCPSessions(registerTools: (server: McpServer) => void) {
  const sessions = new Map<string, MCPSession>()
  let closed = false

  async function createSession(id: string): Promise<MCPTransport> {
    const server = new McpServer({ name: 'starweave-design', version: '0.1.0' })
    registerTools(server)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true
    })
    await server.connect(transport)
    if (closed) {
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
      throw new Error('MCP session manager is closed')
    }
    sessions.set(id, { transport, server })
    return transport
  }

  async function resolve(sessionId?: string): Promise<MCPTransport> {
    if (closed) throw new Error('MCP session manager is closed')
    const existing = sessionId ? sessions.get(sessionId) : undefined
    if (existing) return existing.transport
    if (sessionId) throw new Error('MCP session not found')
    return await createSession(randomUUID())
  }

  async function remove(sessionId: string): Promise<boolean> {
    const session = sessions.get(sessionId)
    if (!session) return false
    sessions.delete(sessionId)
    await closeSession(session)
    return true
  }

  async function clear(): Promise<void> {
    closed = true
    const active = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(active.map(closeSession))
  }

  return { clear, remove, resolve }
}

async function closeSession(session: MCPSession): Promise<void> {
  await session.transport.close().catch(() => undefined)
  await session.server.close().catch(() => undefined)
}
