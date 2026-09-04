import { randomUUID } from 'node:crypto'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ok, registerTools } from '@open-pencil/mcp'
import { z } from 'zod'

type SendRPC = (sessionId: string | undefined, command: string, args: unknown) => Promise<unknown>

type OpenWorkspace = (
  sessionId?: string,
  reveal?: boolean
) => Promise<{ id: string; connected: boolean }>

type SaveFile = (sessionId: string, args: unknown) => Promise<unknown>
type OpenFile = (sessionId: string) => Promise<unknown>
type RestoreDocument = (sessionId: string) => Promise<string | undefined>

const sessionSchema = z.string().uuid().optional().describe(
  'Existing StarWeave Design session to reveal. Omit to open or reuse this MCP connection\'s canvas.'
)

export function registerDesignTools(
  server: McpServer,
  sendRPC: SendRPC,
  openWorkspace: OpenWorkspace,
  saveFile: SaveFile,
  openFile: OpenFile,
  restoreDocument: RestoreDocument = async () => undefined
): void {
  let designSessionId: string | undefined
  let designDocumentId: string | undefined
  let sessionTail = Promise.resolve()

  const withSessionLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = sessionTail
    let release: () => void = () => undefined
    sessionTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  const ensureDesignDocument = async (requestedId?: string, reveal = false) => {
    return await withSessionLock(async () => {
      const session = await openWorkspace(requestedId ?? designSessionId ?? randomUUID(), reveal)
      if ((designSessionId && designSessionId !== session.id) || !session.connected) {
        designDocumentId = undefined
      }
      designSessionId = session.id
      if (!designDocumentId) {
        designDocumentId = await restoreDocument(designSessionId)
        if (!designDocumentId) {
          const created = await sendRPC(designSessionId, 'new_document', {})
          designDocumentId = resultDocumentId(created)
        }
        if (!designDocumentId) throw new Error('StarWeave Design did not create a session document')
      }
      return { ...session, document_id: designDocumentId }
    })
  }

  server.registerTool(
    'open_design_workspace',
    {
      description: 'Open or reveal the StarWeave Design canvas bound to this MCP connection.',
      inputSchema: z.object({ design_session_id: sessionSchema })
    },
    async ({ design_session_id }) => {
      return ok(await ensureDesignDocument(design_session_id, true))
    }
  )

  server.registerTool(
    'open_file',
    {
      description: 'Open a user-approved .fig file in a new StarWeave Design session.',
      inputSchema: z.object({})
    },
    async () => {
      return await withSessionLock(async () => {
        const session = await openWorkspace(randomUUID(), true)
        const result = await openFile(session.id)
        const documentId = resultDocumentId(result)
        if (!documentId) throw new Error('StarWeave Design did not open the selected document')
        designSessionId = session.id
        designDocumentId = documentId
        return ok({ opened: true, design_session_id: session.id, target: resultTarget(result) })
      })
    }
  )

  server.registerTool(
    'new_document',
    {
      description: 'Create a new empty document in a new StarWeave Design session.',
      inputSchema: z.object({})
    },
    async () => {
      return await withSessionLock(async () => {
        const session = await openWorkspace(randomUUID(), true)
        const result = await sendRPC(session.id, 'new_document', {})
        const documentId = resultDocumentId(result)
        if (!documentId) throw new Error('StarWeave Design did not create a new document')
        designSessionId = session.id
        designDocumentId = documentId
        return ok({ created: true, design_session_id: session.id, target: resultTarget(result) })
      })
    }
  )

  // OpenPencil may resolve an adjacent MCP SDK copy; its public registerTool contract is compatible.
  registerTools(server as unknown as Parameters<typeof registerTools>[0], {
    enableEval: false,
    mcpRoot: null,
    sendRPC: async body => {
      const command = typeof body.command === 'string' ? body.command : ''
      if (!command) throw new Error('OpenPencil MCP request is missing its command')
      const workspace = await ensureDesignDocument(undefined, false)
      const args = isRecord(body.args) ? body.args : {}
      const scopedArgs = { ...args, document_id: workspace.document_id }
      if (command === 'save_file') return await saveFile(workspace.id, scopedArgs)
      const result = await sendRPC(workspace.id, command, scopedArgs)
      return command === 'list_documents'
        ? scopeDocumentListing(result, workspace.document_id)
        : result
    }
  })
}

function resultDocumentId(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.target)) return undefined
  return typeof value.target.documentId === 'string' ? value.target.documentId : undefined
}

function resultTarget(value: unknown): unknown {
  return isRecord(value) ? value.target : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scopeDocumentListing(value: unknown, documentId: string): unknown {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.documents)) {
    return value
  }
  return {
    ...value,
    result: {
      ...value.result,
      documents: value.result.documents.filter(
        document => isRecord(document) && document.id === documentId
      )
    }
  }
}
