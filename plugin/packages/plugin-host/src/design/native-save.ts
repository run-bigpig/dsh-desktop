type SendRPC = (sessionId: string | undefined, command: string, args: unknown) => Promise<unknown>

type SavePathResult = {
  path?: string
  cancelled?: boolean
}

type DesignDocument = {
  id: string
  name: string
  active?: boolean
  pages?: Array<{ id?: string }>
}

type NativeDesignSaveOptions = {
  sendRPC: SendRPC
  choosePath: (suggestedName: string) => Promise<SavePathResult>
  createUpload: (path: string) => string
  loadPath?: (sessionId: string) => Promise<string | undefined>
  storePath?: (sessionId: string, path: string) => Promise<void>
}

export function createNativeDesignSave({
  sendRPC,
  choosePath,
  createUpload,
  loadPath = async () => undefined,
  storePath = async () => undefined
}: NativeDesignSaveOptions) {
  const savedPaths = new Map<string, string>()

  return async function save(sessionId: string, args: unknown): Promise<unknown> {
    const target = isRecord(args) ? args : {}
    const listing = await sendRPC(sessionId, 'list_documents', {})
    const document = resolveDocument(listing, target)
    const key = `${sessionId}\0${document.id}`
    let path = savedPaths.get(key) ?? await loadPath(sessionId)
    if (!path) {
      const selected = await choosePath(figFilename(document.name))
      if (selected.cancelled || !selected.path) throw new Error('Save cancelled by user')
      path = selected.path
    }
    const uploadURL = createUpload(path)
    try {
      const result = await sendRPC(sessionId, 'save_file', {
        ...target,
        document_id: document.id,
        starweave_upload_url: uploadURL
      })
      if (isRecord(result) && result.ok === false) savedPaths.delete(key)
      else {
        savedPaths.set(key, path)
        await storePath(sessionId, path)
      }
      return result
    } catch (error) {
      savedPaths.delete(key)
      throw error
    }
  }
}

function resolveDocument(listing: unknown, target: Record<string, unknown>): DesignDocument {
  const envelope = isRecord(listing) && isRecord(listing.result) ? listing.result : listing
  const documents = isRecord(envelope) && Array.isArray(envelope.documents)
    ? envelope.documents.filter(isDesignDocument)
    : []
  const documentId = typeof target.document_id === 'string' ? target.document_id : undefined
  const pageId = typeof target.page_id === 'string' ? target.page_id : undefined
  const document = documentId
    ? documents.find(candidate => candidate.id === documentId)
    : pageId
      ? documents.find(candidate => candidate.pages?.some(page => page.id === pageId))
      : documents.find(candidate => candidate.active) ?? documents[0]
  if (!document) throw new Error('No StarWeave Design document is available to save')
  return document
}

function isDesignDocument(value: unknown): value is DesignDocument {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function figFilename(name: string): string {
  const trimmed = name.trim() || 'Untitled'
  return trimmed.toLowerCase().endsWith('.fig') ? trimmed : `${trimmed}.fig`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
