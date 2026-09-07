import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from '@open-pencil/mcp'
import { z } from 'zod'

type SendRPC = (sessionId: string, command: string, args: unknown) => Promise<unknown>

const USER_OWNED_TOOLS = new Set(['open_file', 'new_document', 'save_file'])

export function registerDesignTools(server: McpServer, sendRPC: SendRPC, designSessionId?: string): void {
  const currentDocument = async () => {
    if (!designSessionId) throw new Error('Design tools require a design-mode Harness session')
    const listing = await sendRPC(designSessionId, 'list_documents', {})
    const documents = isRecord(listing) && isRecord(listing.result) && Array.isArray(listing.result.documents)
      ? listing.result.documents
      : []
    const active = documents.filter(document => isRecord(document) && document.active === true)
    const document = active[0]
    if (active.length !== 1 || !isRecord(document) || typeof document.id !== 'string' || !document.id) {
      throw new Error('请先在设计模式中创建或打开文档')
    }
    return document.id
  }

  const filteredServer = Object.create(server) as McpServer
  filteredServer.registerTool = ((name: string, ...args: unknown[]) => {
    if (USER_OWNED_TOOLS.has(name)) return undefined
    // The official registrar treats every base64 export as an image. PDFs must
    // use MCP resource content so Harness does not send them to an image decoder.
    if (name === 'export_pdf') {
      const callback = args.pop() as (...values: unknown[]) => Promise<{ content: Array<Record<string, unknown>> }>
      args.push(async (...values: unknown[]) => {
        const result = await callback(...values)
        return {
          ...result,
          content: result.content.map(item => item.type === 'image' && item.mimeType === 'application/pdf'
            ? { type: 'resource', resource: { uri: `starweave-design://${designSessionId}/export.pdf`, mimeType: 'application/pdf', blob: item.data } }
            : item)
        }
      })
    }
    return (server.registerTool as (...values: unknown[]) => unknown).call(server, name, ...args)
  }) as McpServer['registerTool']

  registerTools(filteredServer as unknown as Parameters<typeof registerTools>[0], {
    enableEval: false,
    mcpRoot: null,
    sendRPC: async body => {
      if (!designSessionId) throw new Error('Design tools require a design-mode Harness session')
      const command = typeof body.command === 'string' ? body.command : ''
      if (!command || USER_OWNED_TOOLS.has(command)) {
        throw new Error('文件的新建、打开和保存只能由用户在设计画布中操作')
      }
      if (command === 'list_documents') {
        const documentId = await currentDocument()
        const listing = await sendRPC(designSessionId, command, {})
        return scopeDocumentListing(listing, documentId)
      }
      const documentId = await currentDocument()
      const args = isRecord(body.args) ? body.args : {}
      return await sendRPC(designSessionId, command, { ...args, document_id: documentId })
    }
  })

  for (const command of ['undo', 'redo'] as const) {
    server.registerTool(command, {
      description: `${command === 'undo' ? 'Undo' : 'Redo'} the last edit in this Harness session's current design document and persist the resulting document.`,
      inputSchema: {}
    }, async () => {
      try {
        await currentDocument()
        const result = await sendRPC(designSessionId!, command, {})
        if (isRecord(result) && result.ok === false) throw new Error(String(result.error))
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
      }
    })
  }

  server.registerTool('shared_style', {
    description: 'Manage StarWeave design shared styles in the current design session. Create/update from node_id, apply/detach to node_ids (defaults to selection). Updating propagates to all bound nodes; deleting preserves their appearance. Mutations support undo and session persistence.',
    inputSchema: {
      action: z.enum(['list', 'create', 'update', 'rename', 'delete', 'apply', 'detach']),
      kind: z.enum(['fill', 'stroke', 'text', 'effect', 'grid']),
      style_id: z.string().optional(),
      node_id: z.string().optional(),
      node_ids: z.array(z.string()).optional(),
      name: z.string().optional()
    }
  }, async args => {
    try {
      await currentDocument()
      const result = await sendRPC(designSessionId!, 'shared_style', args)
      if (isRecord(result) && result.ok === false) throw new Error(String(result.error))
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scopeDocumentListing(value: unknown, documentId: string): unknown {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.documents)) return value
  return {
    ...value,
    result: {
      ...value.result,
      documents: value.result.documents.filter(document => isRecord(document) && document.id === documentId)
    }
  }
}
