import { readFile } from 'node:fs/promises'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const MAX_DESIGN_DOCUMENT_BASE64_LENGTH = 48 * 1024 * 1024

export interface StoredDesignDocument {
  unsaved?: boolean
  binding?: { id: string; path: string; hash: string | null }
  name: string
  data: string
}

export interface DesignDocumentStore {
  currentBinding?(): StoredDesignDocument['binding']
  load(): Promise<StoredDesignDocument | undefined>
  save(document: StoredDesignDocument): Promise<void>
}

export function createDesignDocumentStore(filename: string): DesignDocumentStore {
  return {
    async load() {
      let source: string
      try {
        source = await readFile(filename, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      const value = JSON.parse(source) as unknown
      if (!isRecord(value) || value.version !== 1 || !isStoredDocument(value.document)) {
        throw new Error('Stored StarWeave design document is invalid')
      }
      return value.document
    },
    async save(document) {
      if (!isStoredDocument(document)) throw new Error('StarWeave design document is invalid')
      await writeFileAtomic(filename, `${JSON.stringify({ version: 1, document })}\n`, {
        mode: 0o600,
        dirMode: 0o700
      })
    }
  }
}

export function isStoredDocument(value: unknown): value is StoredDesignDocument {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 512) {
    return false
  }
  if (value.binding !== undefined && (!isRecord(value.binding) || typeof value.binding.id !== 'string' || typeof value.binding.path !== 'string' || (value.binding.hash !== null && typeof value.binding.hash !== 'string'))) return false
  return typeof value.data === 'string'
    && value.data.length > 0
    && value.data.length <= MAX_DESIGN_DOCUMENT_BASE64_LENGTH
    && value.data.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/u.test(value.data)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
