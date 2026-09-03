import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  isPrivateNetworkAddress,
  startOpenPencilLanCollaborationServer,
  type OpenPencilLanCollaborationServer,
} from '../src/openpencil/collaboration.ts'

let activeServer: OpenPencilLanCollaborationServer | undefined

afterEach(async () => {
  await activeServer?.close()
  activeServer = undefined
})

describe('OpenPencil LAN collaboration relay', () => {
  it('accepts loopback clients, reports peers, and relays binary messages', async () => {
    activeServer = await startOpenPencilLanCollaborationServer(['192.168.50.10'])
    expect(activeServer.session.joinCodes).toEqual([
      expect.stringMatching(/^openpencil-lan:\/\/192\.168\.50\.10:\d+\/[A-Za-z0-9_-]{24}$/u),
    ])

    const first = new WebSocket(activeServer.session.localSocketURL)
    await opened(first)
    const twoPeers = peerCount(first, 2)
    const second = new WebSocket(activeServer.session.localSocketURL)
    await opened(second)
    await twoPeers

    const relayed = binaryMessage(second, 1)
    first.send(Uint8Array.from([1, 9, 8, 7]))
    expect([...await relayed]).toEqual([1, 9, 8, 7])

    first.close()
    second.close()
  })

  it('classifies private and public socket addresses', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:192.168.1.2', '10.0.0.2', '172.31.2.3', '100.64.2.3', 'fd00::1', 'fe80::1']) {
      expect(isPrivateNetworkAddress(address)).toBe(true)
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '2001:4860:4860::8888']) {
      expect(isPrivateNetworkAddress(address)).toBe(false)
    }
  })
})

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function peerCount(socket: WebSocket, expected: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error(`timed out waiting for ${expected} peers`)) }, 5_000)
    socket.on('message', (data) => {
      const payload = Buffer.from(data as ArrayBuffer)
      if (payload[0] !== 4 || payload.readUInt32BE(1) !== expected) return
      clearTimeout(timeout)
      resolve()
    })
  })
}

function binaryMessage(socket: WebSocket, kind: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error(`timed out waiting for message ${kind}`)) }, 5_000)
    socket.on('message', (data) => {
      const payload = Buffer.from(data as ArrayBuffer)
      if (payload[0] !== kind) return
      clearTimeout(timeout)
      resolve(payload)
    })
  })
}
