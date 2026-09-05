import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWorkspaceDesignFiles, validateWorkspaceDesign, type DesignOwner, type WorkspaceDesign } from './workspace-files.ts'
import type { createBrowserSessions } from './browser-sessions.ts'
import type { createDesignSaveUploads } from './save-uploads.ts'

export function createWorkspaceDesignGateway(
  browsers: ReturnType<typeof createBrowserSessions>,
  uploads: ReturnType<typeof createDesignSaveUploads>
) {
  const files = createWorkspaceDesignFiles()
  const documents = new Map<string, WorkspaceDesign>()
  const capabilities = new Map<string, { document: WorkspaceDesign; stamp: string }>()
  const bindings = new Map<string, { uiId: string; token: string }>()
  const writing = new Set<string>()

  function documentFor(id: string) {
    const document = documents.get(id)
    if (!document) throw new Error('Design document has no workspace binding')
    return document
  }

  async function bind(id: string, uiId: string) {
    const document = documentFor(id)
    const previous = bindings.get(id)
    if (previous?.uiId === uiId) {
      const listing = await browsers.sendRPC(id, 'list_documents', {}) as { result?: { documents?: Array<{ id: string; workspace_document_id?: string }> } }
      if (listing.result?.documents?.some(entry => entry.id === uiId && entry.workspace_document_id === id)) return
    }
    const path = await validateWorkspaceDesign(document)
    const create = await stat(path).then(() => false, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && document.saved) throw new Error('Saved design file is missing; restore it or explicitly create a new document')
      if (error.code === 'ENOENT') return true
      throw error
    })
    const token = randomBytes(32).toString('base64url')
    capabilities.set(token, { document, stamp: await fileStamp(path) })
    try {
      await browsers.sendRPC(id, 'bind_workspace_file', {
        document_id: uiId,
        workspace_document_id: id,
        path: document.path,
        create,
        write_url: `/design-workspace/${token}`
      })
      bindings.set(id, { uiId, token })
      if (previous) capabilities.delete(previous.token)
    } catch (error) {
      capabilities.delete(token)
      throw error
    }
  }

  async function open(id: string): Promise<unknown> {
    const listing = await browsers.sendRPC(id, 'list_documents', {}) as { result?: { documents?: Array<{ id: string; active: boolean; workspace_document_id?: string }> } }
    const active = listing.result?.documents?.find(document => document.active)
    if (active?.workspace_document_id === id) return { ok: true, target: { documentId: active.id } }
    const document = documentFor(id)
    const path = await validateWorkspaceDesign(document)
    return await browsers.sendRPC(id, 'open_file', {
      name: basename(path), starweave_download_url: uploads.createDownload(path)
    })
  }

  async function restore(id: string): Promise<string | undefined> {
    const listing = await browsers.sendRPC(id, 'list_documents', {}) as { result?: { documents?: Array<{ id: string; active: boolean; workspace_document_id?: string }> } }
    const active = listing.result?.documents?.find(document => document.active)
    if (active?.workspace_document_id === id) return active.id
    const document = documentFor(id)
    const path = await validateWorkspaceDesign(document)
    try { await stat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && document.saved) throw new Error('Saved design file is missing; restore it or explicitly create a new document')
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const result = await open(id) as { target?: { documentId?: string } }
    return result.target?.documentId
  }

  function lifecycle(owner?: DesignOwner) {
    return {
      select: async (requested?: string, fresh = false, path?: string) => {
        if (!owner) throw new Error('Design tools require a Harness session with a selected workspace')
        const document = path !== undefined ? await files.open(owner, path) : await files.select(owner, requested, fresh)
        documents.set(document.id, document)
        return document.id
      },
      bind
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse, token: string) {
    const capability = capabilities.get(token)
    if (!capability) { response.writeHead(403); response.end('Workspace document permission expired'); return }
    const document = capability.document
    if (request.method === 'POST') {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > 1024) throw new Error('Workspace document request is too large')
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { document_id?: string }
      if (typeof body.document_id !== 'string' || !/^tab-[0-9]+$/u.test(body.document_id)) throw new Error('Invalid UI document ID')
      const created = await files.select({ id: document.owner, workspace: () => document.root }, undefined, true)
      documents.set(created.id, created)
      const session = browsers.prepare(created.id)
      const writeToken = randomBytes(32).toString('base64url')
      capabilities.set(writeToken, { document: created, stamp: 'missing' })
      bindings.set(created.id, { uiId: body.document_id, token: writeToken })
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ documentId: created.id, path: created.path, writeURL: `/design-workspace/${writeToken}`, sessionToken: session.token }))
      return
    }
    if (request.method !== 'PUT') { response.writeHead(405); response.end(); return }
    if (writing.has(document.id)) { response.writeHead(409); response.end('Workspace document save already in progress'); return }
    writing.add(document.id)
    try {
      const path = await validateWorkspaceDesign(document)
      const ticket = uploads.create(path, async () => {
        await validateWorkspaceDesign(document)
        if (await fileStamp(path) !== capability.stamp) throw new Error('Design file changed on disk; save a copy or reopen it before overwriting')
      }, async () => {
        capability.stamp = await fileStamp(path)
        await files.markSaved(document)
      })
      await uploads.handle(request, response, ticket.split('/').pop()!)
    } finally { writing.delete(document.id) }
  }

  return {
    lifecycle, open, restore, handle,
    save: async (id: string, args: unknown) => await browsers.sendRPC(id, 'save_file', args),
    clear: () => { capabilities.clear(); documents.clear(); bindings.clear() }
  }
}

async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true })
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}
