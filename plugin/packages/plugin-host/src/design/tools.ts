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
type OpenFile = (sessionId: string, path?: string) => Promise<unknown>
type RestoreDocument = (sessionId: string) => Promise<string | undefined>
type DocumentLifecycle = {
  select: (requestedId?: string, fresh?: boolean, path?: string) => Promise<string>
  bind: (sessionId: string, documentId: string) => Promise<void>
}

const sessionSchema = z.string().uuid().optional().describe(
  'Existing StarWeave Design session to reveal. Omit to open or reuse this MCP connection\'s canvas.'
)

export function registerDesignTools(
  server: McpServer,
  sendRPC: SendRPC,
  openWorkspace: OpenWorkspace,
  saveFile: SaveFile,
  openFile: OpenFile,
  restoreDocument: RestoreDocument = async () => undefined,
  lifecycle?: DocumentLifecycle
): void {
  let designSessionId: string | undefined
  let designDocumentId: string | undefined
  let sessionTail = Promise.resolve()

  const sessionDocument = async (sessionId: string) => {
    // The UI creates and binds a tab when it opens a browser session. Its listing
    // marks that session's document active, independently of the visible tab.
    const listing = await sendRPC(sessionId, 'list_documents', {})
    const documents = isRecord(listing) && isRecord(listing.result) && Array.isArray(listing.result.documents)
      ? listing.result.documents
      : []
    const active = documents.filter(document => isRecord(document) && document.active === true)
    const document = active[0]
    if (active.length !== 1 || !isRecord(document) || typeof document.id !== 'string' || !document.id) {
      throw new Error('StarWeave Design did not identify its session document')
    }
    return {
      documentId: document.id,
      documentName: document.name,
      ...(typeof document.path === 'string' ? { path: document.path } : {}),
      pageId: document.current_page_id,
      pageName: document.current_page_name
    }
  }

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
      const id = lifecycle
        ? await lifecycle.select(requestedId ?? designSessionId)
        : requestedId ?? designSessionId ?? randomUUID()
      const session = await openWorkspace(id, reveal)
      if ((designSessionId && designSessionId !== session.id) || !session.connected) {
        designDocumentId = undefined
      }
      designSessionId = session.id
      if (!designDocumentId) {
        designDocumentId = await restoreDocument(designSessionId)
        if (!designDocumentId) {
          designDocumentId = (await sessionDocument(designSessionId)).documentId
        }
        if (!designDocumentId) throw new Error('StarWeave Design did not create a session document')
        try { await lifecycle?.bind(session.id, designDocumentId) } catch (error) {
          designDocumentId = undefined
          throw error
        }
      }
      return { ...session, design_session_id: session.id, document_id: designDocumentId }
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
      description: 'Open a .fig file by workspace-relative path, without a file picker. Use open_design_workspace with design_session_id to resume a known design.',
      inputSchema: z.object({ path: z.string().optional().describe('Workspace-relative .fig path, e.g. designs/Landing.fig') })
    },
    async ({ path }) => {
      return await withSessionLock(async () => {
        const id = lifecycle ? await lifecycle.select(undefined, false, path ?? '') : randomUUID()
        const session = await openWorkspace(id, true)
        const result = path === undefined ? await openFile(session.id) : await openFile(session.id, path)
        const documentId = resultDocumentId(result)
        if (!documentId) throw new Error('StarWeave Design did not open the selected document')
        designSessionId = session.id
        designDocumentId = documentId
        try { await lifecycle?.bind(session.id, documentId) } catch (error) {
          designDocumentId = undefined
          throw error
        }
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
        const id = lifecycle ? await lifecycle.select(undefined, true) : randomUUID()
        const session = await openWorkspace(id, true)
        const target = await sessionDocument(session.id)
        designSessionId = session.id
        designDocumentId = target.documentId
        try { await lifecycle?.bind(session.id, target.documentId) } catch (error) {
          designDocumentId = undefined
          throw error
        }
        return ok({ created: true, design_session_id: session.id, target })
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
