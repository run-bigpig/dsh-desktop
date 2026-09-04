import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createNativeDesignSave } from '../src/design/native-save.ts'
import { createDesignSaveUploads } from '../src/design/save-uploads.ts'
import { createDesignSessionFiles } from '../src/design/session-files.ts'

describe('StarWeave native design save', () => {
  it('chooses a path once and silently overwrites the same session document', async () => {
    const sendRPC = vi.fn()
      .mockResolvedValueOnce(documentListing())
      .mockResolvedValueOnce({ ok: true, target: { documentId: 'document-1' } })
      .mockResolvedValueOnce(documentListing())
      .mockResolvedValueOnce({ ok: true, target: { documentId: 'document-1' } })
    const choosePath = vi.fn().mockResolvedValue({ path: '/tmp/Landing.fig', cancelled: false })
    const createUpload = vi.fn()
      .mockReturnValueOnce('/design-save/first')
      .mockReturnValueOnce('/design-save/second')
    const save = createNativeDesignSave({ sendRPC, choosePath, createUpload })

    await expect(save('session-1', { document_id: 'document-1' })).resolves.toMatchObject({ ok: true })
    await expect(save('session-1', { document_id: 'document-1' })).resolves.toMatchObject({ ok: true })

    expect(choosePath).toHaveBeenCalledOnce()
    expect(choosePath).toHaveBeenCalledWith('Landing.fig')
    expect(createUpload).toHaveBeenNthCalledWith(1, '/tmp/Landing.fig')
    expect(createUpload).toHaveBeenNthCalledWith(2, '/tmp/Landing.fig')
    expect(sendRPC).toHaveBeenNthCalledWith(2, 'session-1', 'save_file', {
      document_id: 'document-1',
      starweave_upload_url: '/design-save/first'
    })
    expect(sendRPC).toHaveBeenNthCalledWith(4, 'session-1', 'save_file', {
      document_id: 'document-1',
      starweave_upload_url: '/design-save/second'
    })
  })

  it('asks again after a failed save and stops cleanly when the dialog is cancelled', async () => {
    const sendRPC = vi.fn()
      .mockResolvedValueOnce(documentListing())
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce(documentListing())
    const choosePath = vi.fn()
      .mockResolvedValueOnce({ path: '/tmp/Landing.fig', cancelled: false })
      .mockResolvedValueOnce({ cancelled: true })
    const createUpload = vi.fn().mockReturnValue('/design-save/upload')
    const save = createNativeDesignSave({ sendRPC, choosePath, createUpload })

    await expect(save('session-1', {})).rejects.toThrow('upload failed')
    await expect(save('session-1', {})).rejects.toThrow('Save cancelled by user')

    expect(choosePath).toHaveBeenCalledTimes(2)
    expect(createUpload).toHaveBeenCalledOnce()
  })

  it('reuses a persisted session path without opening the save dialog', async () => {
    const sendRPC = vi.fn()
      .mockResolvedValueOnce(documentListing())
      .mockResolvedValueOnce({ ok: true, target: { documentId: 'document-1' } })
    const choosePath = vi.fn()
    const createUpload = vi.fn().mockReturnValue('/design-save/upload')
    const save = createNativeDesignSave({
      sendRPC,
      choosePath,
      createUpload,
      loadPath: async () => '/tmp/Persisted.fig'
    })

    await expect(save('session-1', {})).resolves.toMatchObject({ ok: true })
    expect(choosePath).not.toHaveBeenCalled()
    expect(createUpload).toHaveBeenCalledWith('/tmp/Persisted.fig')
  })
})

describe('StarWeave design save upload', () => {
  it('atomically replaces the target and consumes each upload ticket once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starweave-design-save-'))
    const target = join(root, 'Canvas.fig')
    const uploads = createDesignSaveUploads()
    const server = createServer((request, response) => {
      const token = request.url?.split('/').pop() ?? ''
      const handler = request.url?.startsWith('/design-open/')
        ? uploads.handleDownload
        : uploads.handle
      void handler(request, response, token)
    })
    try {
      await writeFile(target, 'old design')
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address() as AddressInfo
      const uploadPath = uploads.create(target)
      const uploadURL = `http://127.0.0.1:${address.port}${uploadPath}`

      const saved = await fetch(uploadURL, { method: 'PUT', body: Buffer.from('new design') })
      expect(saved.status).toBe(200)
      await expect(readFile(target, 'utf8')).resolves.toBe('new design')

      const reused = await fetch(uploadURL, { method: 'PUT', body: Buffer.from('unexpected') })
      expect(reused.status).toBe(404)
      await expect(readFile(target, 'utf8')).resolves.toBe('new design')

      const downloadPath = uploads.createDownload(target)
      const downloadURL = `http://127.0.0.1:${address.port}${downloadPath}`
      const restored = await fetch(downloadURL, { method: 'POST' })
      expect(restored.status).toBe(200)
      await expect(restored.text()).resolves.toBe('new design')
      expect((await fetch(downloadURL, { method: 'POST' })).status).toBe(404)
    } finally {
      uploads.clear()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not consume a ticket for the wrong HTTP method', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starweave-design-save-method-'))
    const target = join(root, 'Canvas.fig')
    const uploads = createDesignSaveUploads()
    const server = createServer((request, response) => {
      const token = request.url?.split('/').pop() ?? ''
      void uploads.handle(request, response, token)
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address() as AddressInfo
      const uploadPath = uploads.create(target)
      const uploadURL = `http://127.0.0.1:${address.port}${uploadPath}`

      expect((await fetch(uploadURL)).status).toBe(405)
      expect((await fetch(uploadURL, { method: 'PUT', body: Buffer.from('design') })).status).toBe(200)
      await expect(readFile(target, 'utf8')).resolves.toBe('design')
    } finally {
      uploads.clear()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('StarWeave design session files', () => {
  it('persists and reloads a saved file for a design session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starweave-design-session-'))
    const target = join(root, 'Saved.fig')
    try {
      await writeFile(target, 'saved design')
      await createDesignSessionFiles(root).set('session-1', target)
      await expect(createDesignSessionFiles(root).get('session-1')).resolves.toBe(target)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects non-absolute or non-fig session paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starweave-design-session-invalid-'))
    try {
      const files = createDesignSessionFiles(root)
      await expect(files.set('session-1', 'relative.fig')).rejects.toThrow('absolute .fig path')
      await expect(files.set('session-1', join(root, 'Saved.png'))).rejects.toThrow('absolute .fig path')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function documentListing() {
  return {
    ok: true,
    result: {
      documents: [{
        id: 'document-1',
        name: 'Landing',
        active: true,
        pages: [{ id: 'page-1' }]
      }]
    }
  }
}
