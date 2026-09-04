import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, extname, isAbsolute } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_SAVE_BYTES = 256 * 1024 * 1024
const TICKET_TTL_MS = 60_000
const MAX_TICKETS = 32

type SaveTicket = {
  path: string
  expiresAt: number
}

export function createDesignSaveUploads() {
  const uploadTickets = new Map<string, SaveTicket>()
  const downloadTickets = new Map<string, SaveTicket>()

  function pruneExpired(): void {
    const now = Date.now()
    for (const tickets of [uploadTickets, downloadTickets]) {
      for (const [token, ticket] of tickets) {
        if (ticket.expiresAt <= now) tickets.delete(token)
      }
    }
  }

  function create(path: string): string {
    pruneExpired()
    if (!isAbsolute(path) || extname(path).toLowerCase() !== '.fig') {
      throw new Error('StarWeave Design save path must be an absolute .fig path')
    }
    if (uploadTickets.size + downloadTickets.size >= MAX_TICKETS) {
      throw new Error('Too many pending StarWeave Design file transfers')
    }
    const token = randomBytes(32).toString('base64url')
    uploadTickets.set(token, { path, expiresAt: Date.now() + TICKET_TTL_MS })
    return `/design-save/${token}`
  }

  function createDownload(path: string): string {
    pruneExpired()
    if (!isAbsolute(path) || extname(path).toLowerCase() !== '.fig') {
      throw new Error('StarWeave Design open path must be an absolute .fig path')
    }
    if (uploadTickets.size + downloadTickets.size >= MAX_TICKETS) {
      throw new Error('Too many pending StarWeave Design file transfers')
    }
    const token = randomBytes(32).toString('base64url')
    downloadTickets.set(token, { path, expiresAt: Date.now() + TICKET_TTL_MS })
    return `/design-open/${token}`
  }

  async function handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    pruneExpired()
    if (request.method !== 'PUT') return writeJSON(response, 405, { error: 'method not allowed' })
    const ticket = uploadTickets.get(token)
    uploadTickets.delete(token)
    if (!ticket) return writeJSON(response, 404, { error: 'save ticket not found or expired' })
    const declaredLength = Number(request.headers['content-length'] ?? 0)
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_SAVE_BYTES) {
      return writeJSON(response, 413, { error: 'design file is too large' })
    }

    const temporary = `${ticket.path}.${randomUUID()}.tmp`
    let file: FileHandle | undefined
    let output: WriteStream | undefined
    try {
      await mkdir(dirname(ticket.path), { recursive: true })
      file = await open(temporary, 'wx', 0o600)
      output = createWriteStream(temporary, { fd: file.fd, autoClose: false })
      let received = 0
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          if (received > MAX_SAVE_BYTES) callback(new Error('design file is too large'))
          else callback(null, chunk)
        }
      })
      await pipeline(request, limiter, output)
      await file.sync()
      await file.close()
      file = undefined
      await rename(temporary, ticket.path)
      writeJSON(response, 200, { saved: true })
    } catch (error) {
      output?.destroy()
      await file?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      const tooLarge = error instanceof Error && error.message === 'design file is too large'
      writeJSON(response, tooLarge ? 413 : 500, {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async function handleDownload(
    request: IncomingMessage,
    response: ServerResponse,
    token: string
  ): Promise<void> {
    pruneExpired()
    if (request.method !== 'POST') return writeJSON(response, 405, { error: 'method not allowed' })
    const ticket = downloadTickets.get(token)
    downloadTickets.delete(token)
    if (!ticket) return writeJSON(response, 404, { error: 'open ticket not found or expired' })
    let info
    try {
      info = await stat(ticket.path)
    } catch {
      return writeJSON(response, 404, { error: 'saved design file was not found' })
    }
    if (!info.isFile() || info.size > MAX_SAVE_BYTES) {
      return writeJSON(response, 413, { error: 'design file is too large' })
    }
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Content-Length', String(info.size))
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    await pipeline(createReadStream(ticket.path), response)
  }

  return {
    clear: () => {
      uploadTickets.clear()
      downloadTickets.clear()
    },
    create,
    createDownload,
    handle,
    handleDownload
  }
}

function writeJSON(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(JSON.stringify(value))
}
