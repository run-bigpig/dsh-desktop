import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from '@open-pencil/mcp'

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
