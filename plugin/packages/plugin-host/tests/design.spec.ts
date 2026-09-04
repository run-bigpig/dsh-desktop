import { once } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { createBrowserSessions } from '../src/design/browser-sessions.ts'
import { startDesignServer, type DesignServer } from '../src/design/server.ts'

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
    sessions.close()
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
