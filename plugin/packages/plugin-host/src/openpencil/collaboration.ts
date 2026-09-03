import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import type { OpenPencilCollaborationHostSession } from '../shared/types.ts'

const COLLABORATION_PATH = '/openpencil-collab/'
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const PEER_COUNT_MESSAGE = 4

export interface OpenPencilLanCollaborationServer {
  readonly session: OpenPencilCollaborationHostSession
  readonly close: () => Promise<void>
}

export async function startOpenPencilLanCollaborationServer(
  addresses = privateIPv4Addresses(),
): Promise<OpenPencilLanCollaborationServer> {
  const usableAddresses = [...new Set(addresses.filter(address => isPrivateNetworkAddress(address) && !isLoopback(address)))]
  if (usableAddresses.length === 0) {
    throw new Error('openpencil: no private IPv4 network interface is available for LAN collaboration')
  }

  const roomToken = randomBytes(18).toString('base64url')
  const hostKey = randomBytes(24).toString('base64url')
  const path = `${COLLABORATION_PATH}${roomToken}`
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })

  server.on('upgrade', (request, socket, head) => {
    const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname
    if (
      requestPath !== path
      || !isPrivateNetworkAddress(request.socket.localAddress ?? '')
      || !isPrivateNetworkAddress(request.socket.remoteAddress ?? '')
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, client => { sockets.emit('connection', client, request) })
  })

  const broadcastPeerCount = (): void => {
    const payload = Buffer.allocUnsafe(5)
    payload[0] = PEER_COUNT_MESSAGE
    payload.writeUInt32BE(sockets.clients.size, 1)
    for (const client of sockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload, { binary: true })
    }
  }

  sockets.on('connection', client => {
    broadcastPeerCount()
    client.on('message', (data, isBinary) => {
      const payload = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data)
      if (!isBinary || payload.byteLength === 0 || payload[0] === PEER_COUNT_MESSAGE) {
        client.close(1008, 'Binary collaboration messages only')
        return
      }
      for (const peer of sockets.clients) {
        if (peer !== client && peer.readyState === WebSocket.OPEN) peer.send(payload, { binary: true })
      }
    })
    client.once('close', broadcastPeerCount)
  })

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => { reject(error) }
    server.once('error', fail)
    server.listen(0, '0.0.0.0', () => {
      server.off('error', fail)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server, sockets)
    throw new Error('openpencil: LAN collaboration server did not expose a TCP port')
  }

  const session: OpenPencilCollaborationHostSession = {
    hostKey,
    roomToken,
    localSocketURL: `ws://127.0.0.1:${address.port}${path}`,
    joinCodes: usableAddresses.map(host => `openpencil-lan://${host}:${address.port}/${roomToken}`),
  }
  let closed = false
  return {
    session,
    close: async () => {
      if (closed) return
      closed = true
      await closeServer(server, sockets)
    },
  }
}

async function closeServer(
  server: ReturnType<typeof createServer>,
  sockets: WebSocketServer,
): Promise<void> {
  for (const client of sockets.clients) client.terminate()
  await new Promise<void>(resolve => { sockets.close(() => { resolve() }) })
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
}

export function privateIPv4Addresses(): string[] {
  const candidates: Array<{ readonly name: string; readonly address: string }> = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || !isPrivateNetworkAddress(entry.address)) continue
      candidates.push({ name, address: entry.address })
    }
  }
  return candidates
    .sort((left, right) => interfaceScore(left.name) - interfaceScore(right.name) || left.address.localeCompare(right.address))
    .map(candidate => candidate.address)
}

function interfaceScore(name: string): number {
  return /(?:virtual|vethernet|wsl|docker|vmware|virtualbox|loopback)/iu.test(name) ? 1 : 0
}

export function isPrivateNetworkAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^::ffff:/u, '').replace(/^\[|\]$/gu, '')
  if (address === '::1') return true
  if (/^(?:fc|fd)[0-9a-f]{2}:/u.test(address)) return true
  if (/^fe[89ab][0-9a-f]:/u.test(address)) return true
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [first = Number.NaN, second = Number.NaN] = octets
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
}

function isLoopback(value: string): boolean {
  return value === '::1' || value.startsWith('127.')
}
