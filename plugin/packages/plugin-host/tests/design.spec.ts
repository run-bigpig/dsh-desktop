import { once } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebSocket } from 'ws'

import { createBrowserSessions } from '../src/design/browser-sessions.ts'
import { startDesignServer, type DesignServer } from '../src/design/server.ts'
import { registerStarWeaveDesignSkill } from '../src/design/skill.ts'
import { registerDesignTools } from '../src/design/tools.ts'

const activeServers: DesignServer[] = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(server => server.close()))
})

describe('StarWeave Design browser sessions', () => {
  it('routes an RPC response through the authenticated design session', async () => {
    const opened: Array<{ id: string; token: string }> = []
    const sessions = createBrowserSessions(async session => {
      opened.push({ id: session.id, token: session.token })
    })
    const session = await sessions.ensureOpen()
    expect(opened).toEqual([{ id: session.id, token: session.token }])

    const send = vi.fn()
    const socket = {
      OPEN: WebSocket.OPEN,
      readyState: WebSocket.OPEN,
      send,
      close: vi.fn()
    } as unknown as WebSocket
    sessions.handleMessage(socket, {
      type: 'register',
      sessionId: session.id,
      token: session.token
    })

    const pending = sessions.sendRPC(session.id, 'tool', { name: 'get_selection' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    const request = JSON.parse(String(send.mock.calls[1]?.[0])) as { id: string }
    sessions.handleMessage(socket, {
      type: 'response',
      id: request.id,
      ok: true,
      result: { selection: [] }
    })
    await expect(pending).resolves.toMatchObject({ ok: true, result: { selection: [] } })

    await sessions.ensureOpen(session.id, true)
    expect(opened).toHaveLength(2)
    sessions.close()
  })
})

describe('StarWeave Design MCP tools', () => {
  it('adds workspace opening and delegates save_file to the official OpenPencil registry', async () => {
    const callbacks = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
    const server = {
      registerTool(name: string, _options: unknown, callback: (args: Record<string, unknown>) => Promise<unknown>) {
        callbacks.set(name, callback)
      }
    } as unknown as McpServer
    const sendRPC = vi.fn().mockResolvedValue({ ok: true, target: { documentId: 'document-1' } })
    const designSessionId = '123e4567-e89b-42d3-a456-426614174000'
    const openWorkspace = vi.fn().mockResolvedValue({ id: designSessionId, connected: true })

    registerDesignTools(server, sendRPC, openWorkspace)

    expect(callbacks.has('list_documents')).toBe(true)
    const save = callbacks.get('save_file')
    expect(save).toBeDefined()
    expect(callbacks.has('get_codegen_prompt')).toBe(true)
    expect(callbacks.has('list_design_documents')).toBe(false)

    await callbacks.get('open_design_workspace')?.({ design_session_id: designSessionId })
    const result = await save?.({
      document_id: 'document-1'
    })
    expect(openWorkspace).toHaveBeenCalledWith(designSessionId, true)
    expect(sendRPC).toHaveBeenCalledWith(
      designSessionId,
      'save_file',
      { document_id: 'document-1' }
    )
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ saved: true, target: { documentId: 'document-1' } }, null, 2)
        }
      ]
    })
  })

  it('opens a StarWeave canvas lazily when an official tool is called first', async () => {
    const callbacks = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
    const server = {
      registerTool(name: string, _options: unknown, callback: (args: Record<string, unknown>) => Promise<unknown>) {
        callbacks.set(name, callback)
      }
    } as unknown as McpServer
    const designSessionId = '123e4567-e89b-42d3-a456-426614174000'
    const openWorkspace = vi.fn().mockResolvedValue({ id: designSessionId, connected: false })
    const sendRPC = vi.fn().mockResolvedValue({ ok: true, result: { documents: [] } })

    registerDesignTools(server, sendRPC, openWorkspace)
    await callbacks.get('list_documents')?.({})

    expect(openWorkspace).toHaveBeenCalledWith(undefined, false)
    expect(sendRPC).toHaveBeenCalledWith(designSessionId, 'list_documents', {})
  })
})

describe('StarWeave Design skill', () => {
  it('loads the bundled real-time spatial design workflow', async () => {
    const register = vi.fn(() => () => {})
    await registerStarWeaveDesignSkill({ skills: { register } } as never)

    expect(register).toHaveBeenCalledOnce()
    const skill = register.mock.calls[0]?.[0]
    expect(skill?.name).toBe('starweave-design')
    expect(skill?.content).toContain('open_design_workspace')
    expect(skill?.content).toContain('list_documents')
    expect(skill?.content).toContain('render(parent_id=区域ID)')
    expect(skill?.content).toContain('不同 `parent_id`')
    expect(skill?.content).toContain('get_selection')
    expect(skill?.content).toContain('[Image: 文件名]')
    expect(skill?.content).toContain('save_file')
    expect(skill?.content).not.toContain('禁止并行发起会修改画布的工具调用')
    expect(skill?.resourceBase.path).toMatch(/starweave-design[/\\]$/)
  })
})

describe('StarWeave Design LAN server', () => {
  it('serves only the local gateway and relays broadcast and targeted room messages', async () => {
    const server = await startDesignServer('test-token')
    activeServers.push(server)
    const origin = `http://127.0.0.1:${server.port}`

    await expect(fetch(`${origin}/`)).resolves.toMatchObject({ status: 200 })
    await expect(fetch(`${origin}/mcp`)).resolves.toMatchObject({ status: 401 })

    const room = 'abcdefghijklmnopqrstuvwx'
    await expect(rejectedUpgrade(
      `${origin.replace('http:', 'ws:')}/collaboration/${room}`,
      'https://openpencil.dev'
    )).resolves.toBe(403)

    const first = new WebSocket(`${origin.replace('http:', 'ws:')}/collaboration/${room}`, {
      origin
    })
    const firstWelcomeMessage = nextText(first)
    await once(first, 'open')
    const firstWelcome = JSON.parse(await firstWelcomeMessage) as { peerId: string }

    const firstJoin = nextText(first)
    const second = new WebSocket(`${origin.replace('http:', 'ws:')}/collaboration/${room}`, {
      origin
    })
    const secondWelcomeMessage = nextText(second)
    await once(second, 'open')
    const secondWelcome = JSON.parse(await secondWelcomeMessage) as { peerId: string }
    await firstJoin

    const broadcast = nextBinary(second)
    first.send(actionFrame('sync', '', new Uint8Array([1, 2, 3])))
    expect(decodeActionFrame(await broadcast)).toEqual({
      namespace: 'sync',
      peerId: firstWelcome.peerId,
      payload: [1, 2, 3]
    })

    const targeted = nextBinary(first)
    second.send(actionFrame('awareness', firstWelcome.peerId, new Uint8Array([9, 8])))
    expect(decodeActionFrame(await targeted)).toEqual({
      namespace: 'awareness',
      peerId: secondWelcome.peerId,
      payload: [9, 8]
    })

    first.close()
    second.close()
  })
})

function rejectedUpgrade(url: string, origin: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const socket = new WebSocket(url, { origin })
    socket.once('unexpected-response', (_request, response) => {
      resolveStatus(response.statusCode ?? 0)
      socket.terminate()
    })
    socket.once('open', () => {
      socket.terminate()
      reject(new Error('WebSocket upgrade unexpectedly succeeded'))
    })
    socket.once('error', reject)
  })
}

function nextText(socket: WebSocket): Promise<string> {
  return new Promise((resolveMessage, reject) => {
    socket.once('error', reject)
    socket.once('message', data => resolveMessage(data.toString()))
  })
}

function nextBinary(socket: WebSocket): Promise<Buffer> {
  return new Promise((resolveMessage, reject) => {
    socket.once('error', reject)
    socket.once('message', data => resolveMessage(Buffer.from(data as ArrayBuffer)))
  })
}

function actionFrame(namespace: string, target: string, payload: Uint8Array): Buffer {
  const namespaceBytes = Buffer.from(namespace)
  const targetBytes = Buffer.from(target)
  return Buffer.concat([
    Buffer.from([1, namespaceBytes.length, targetBytes.length]),
    namespaceBytes,
    targetBytes,
    payload
  ])
}

function decodeActionFrame(frame: Buffer) {
  const namespaceLength = frame[1] ?? 0
  const peerLength = frame[2] ?? 0
  const peerStart = 3 + namespaceLength
  const payloadStart = peerStart + peerLength
  return {
    namespace: frame.subarray(3, peerStart).toString(),
    peerId: frame.subarray(peerStart, payloadStart).toString(),
    payload: [...frame.subarray(payloadStart)]
  }
}
