import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesignSaveUploads } from '../src/design/save-uploads.ts'
import { createWorkspaceDesignGateway } from '../src/design/workspace-gateway.ts'
import type { createBrowserSessions } from '../src/design/browser-sessions.ts'

afterEach(() => vi.unstubAllEnvs())

describe('workspace design gateway', () => {
  it('creates, autosaves, and restores actual workspace bytes without a file picker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starweave-design-gateway-'))
    const workspace = join(root, 'project')
    await mkdir(workspace)
    vi.stubEnv('STARWEAVE_DESIGN_STATE_DIR', join(root, 'state'))
    const uploads = createDesignSaveUploads()
    let boundId: string | undefined
    let writeURL = ''
    let restored = ''
    let origin = ''
    const sendRPC = vi.fn(async (_id: string, command: string, args: Record<string, unknown>) => {
      if (command === 'list_documents') return { ok: true, result: { documents: [{ id: 'tab-1', active: true, workspace_document_id: boundId }] } }
      if (command === 'bind_workspace_file') {
        boundId = String(args.workspace_document_id)
        writeURL = String(args.write_url)
        if (args.create) {
          const response = await fetch(origin + writeURL, { method: 'PUT', body: 'initial fig' })
          expect(response.status).toBe(200)
        }
        return { ok: true }
      }
      if (command === 'open_file') {
        const response = await fetch(origin + String(args.starweave_download_url), { method: 'POST' })
        restored = await response.text()
        return { ok: true, target: { documentId: 'tab-1' } }
      }
      throw new Error(`Unexpected RPC: ${command}`)
    })
    const gateway = createWorkspaceDesignGateway({ sendRPC } as unknown as ReturnType<typeof createBrowserSessions>, uploads)
    const server = createServer((request, response) => {
      const token = request.url!.split('/').pop()!
      const operation = request.url!.startsWith('/design-open/')
        ? uploads.handleDownload(request, response, token)
        : gateway.handle(request, response, token)
      void operation.catch(error => { response.writeHead(500); response.end(String(error)) })
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const lifecycle = gateway.lifecycle({ id: 'chat-a', workspace: () => workspace })
      const id = await lifecycle.select()
      await lifecycle.bind(id, 'tab-1')
      const path = join(workspace, 'designs', `Untitled-${id}.fig`)
      expect(await readFile(path, 'utf8')).toBe('initial fig')
      const saved = await fetch(origin + writeURL, { method: 'PUT', body: 'edited fig' })
      expect(saved.status).toBe(200)
      expect(await readFile(path, 'utf8')).toBe('edited fig')
      expect((await fetch(origin + '/design-workspace/' + 'a'.repeat(43), { method: 'PUT', body: 'bad' })).status).toBe(403)
      expect(await lifecycle.select()).toBe(id)
      boundId = undefined // A recreated UI has no persistent file binding yet.
      expect(await gateway.restore(id)).toBe('tab-1')
      expect(restored).toBe('edited fig')
      await lifecycle.bind(id, 'tab-1')
      expect(await readFile(path, 'utf8')).toBe('edited fig')
      await writeFile(path, 'external edit')
      const conflict = await fetch(origin + writeURL, { method: 'PUT', body: 'stale overwrite' })
      expect(conflict.status).toBe(500)
      expect(await readFile(path, 'utf8')).toBe('external edit')
      await lifecycle.bind(id, 'tab-1')
      expect(await readFile(path, 'utf8')).toBe('external edit')
      await expect(gateway.lifecycle({ id: 'chat-b', workspace: () => workspace }).select(id)).rejects.toThrow('does not belong')
    } finally {
      gateway.clear()
      uploads.clear()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
})
