import * as Y from 'yjs'
import type { Editor } from '@open-pencil/core/editor'
import type { SceneNode } from '@open-pencil/scene-graph'
import type { OpenPencilCollaborationHostSession } from '@run-bigpig/dsh-desktop-plugin-host/types'

const COLLABORATION_PATH = '/openpencil-collab/'
const ROOM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24}$/u
const UPDATE_MESSAGE = 1
const SYNC_REQUEST_MESSAGE = 2
const SYNC_RESPONSE_MESSAGE = 3
const PEER_COUNT_MESSAGE = 4
const REMOTE_ORIGIN = 'openpencil-lan-remote'

export interface CollaborationSnapshot {
  readonly active: boolean
  readonly connected: boolean
  readonly roomId: string | null
  readonly peerCount: number
  readonly joinCodes: readonly string[]
}

export interface CollaborationHostBridge {
  readonly start: () => Promise<OpenPencilCollaborationHostSession>
  readonly stop: (hostKey: string) => Promise<void>
}

export interface OpenPencilCollaboration {
  readonly isActive: () => boolean
  readonly share: () => Promise<readonly string[]>
  readonly join: (value: string) => Promise<string>
  readonly leave: () => Promise<void>
}

export function createOpenPencilCollaboration(
  editor: Editor,
  hostBridge: CollaborationHostBridge,
  onChange: (snapshot: CollaborationSnapshot) => void,
): OpenPencilCollaboration {
  let socket: WebSocket | null = null
  let ydoc: Y.Doc | null = null
  let ynodes: Y.Map<Y.Map<unknown>> | null = null
  let yimages: Y.Map<Uint8Array> | null = null
  let suppressGraphSync = false
  let suppressYjsEvents = false
  let unbindGraphEvents: (() => void) | null = null
  let hostKey: string | null = null
  let snapshot: CollaborationSnapshot = disconnectedSnapshot()

  const publish = (next: Partial<CollaborationSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    onChange(snapshot)
  }

  const send = (kind: number, payload: Uint8Array): void => {
    if (socket?.readyState !== WebSocket.OPEN) return
    const message = new Uint8Array(payload.byteLength + 1)
    message[0] = kind
    message.set(payload, 1)
    socket.send(message)
  }

  const syncNode = (nodeId: string): void => {
    if (suppressGraphSync || !ydoc || !ynodes) return
    const node = editor.graph.getNode(nodeId)
    if (!node) return
    suppressYjsEvents = true
    try {
      ydoc.transact(() => {
        let ynode = ynodes?.get(nodeId)
        if (!ynode) {
          ynode = new Y.Map()
          ynodes?.set(nodeId, ynode)
        }
        syncNodeProps(node, ynode)
        for (const fill of node.fills) {
          if (!fill.imageHash || yimages?.has(fill.imageHash)) continue
          const data = editor.graph.images.get(fill.imageHash)
          if (data) yimages?.set(fill.imageHash, data)
        }
      })
    } finally {
      suppressYjsEvents = false
    }
  }

  const syncDocument = (): void => {
    if (!ydoc || !ynodes || !yimages) return
    suppressYjsEvents = true
    try {
      ydoc.transact(() => {
        for (const node of editor.graph.getAllNodes()) {
          let ynode = ynodes?.get(node.id)
          if (!ynode) {
            ynode = new Y.Map()
            ynodes?.set(node.id, ynode)
          }
          syncNodeProps(node, ynode)
        }
        for (const [hash, data] of editor.graph.images) yimages?.set(hash, data)
      })
    } finally {
      suppressYjsEvents = false
    }
  }

  const ensureCurrentPage = (): void => {
    const pages = editor.graph.getPages()
    if (pages.some(page => page.id === editor.state.currentPageId) || pages.length === 0) return
    void editor.switchPage(pages[0].id)
  }

  const applyYNode = (nodeId: string, ynode: Y.Map<unknown>): void => {
    const props = yNodeToProps(ynode)
    const parentId = typeof props.parentId === 'string' ? props.parentId : null
    const existing = editor.graph.getNode(nodeId)
    if (existing) editor.graph.updateNode(nodeId, props as Partial<SceneNode>)
    else if (typeof props.type === 'string') {
      editor.graph.createNodeWithId(nodeId, props.type as SceneNode['type'], parentId, props as Partial<SceneNode>)
    }
    if (parentId === null) editor.graph.rootId = nodeId
    ensureCurrentPage()
  }

  const applyYjsEvents = (events: Y.YEvent<Y.Map<unknown>>[]): void => {
    if (!ynodes) return
    for (const event of events) {
      if (event.target === ynodes) {
        for (const [nodeId, change] of event.changes.keys) {
          if (change.action === 'delete') editor.graph.deleteNode(nodeId)
          else {
            const ynode = ynodes.get(nodeId)
            if (ynode) applyYNode(nodeId, ynode)
          }
        }
      } else if (event.target.parent === ynodes) {
        for (const [nodeId, candidate] of ynodes.entries()) {
          if (candidate === event.target) {
            applyYNode(nodeId, candidate)
            break
          }
        }
      }
    }
  }

  const bindGraphEvents = (): (() => void) => {
    const unbinds = [
      editor.onEditorEvent('node:updated', id => { syncNode(id) }),
      editor.onEditorEvent('node:created', node => { syncNode(node.id) }),
      editor.onEditorEvent('node:reparented', nodeId => { syncNode(nodeId) }),
      editor.onEditorEvent('node:reordered', nodeId => { syncNode(nodeId) }),
      editor.onEditorEvent('node:deleted', id => {
        if (suppressGraphSync || !ydoc || !ynodes) return
        suppressYjsEvents = true
        try {
          ydoc.transact(() => { ynodes?.delete(id) })
        } finally {
          suppressYjsEvents = false
        }
      }),
    ]
    return () => { for (const unbind of unbinds) unbind() }
  }

  const resetLocal = (): void => {
    const previousSocket = socket
    socket = null
    if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) previousSocket.close(1000)
    unbindGraphEvents?.()
    unbindGraphEvents = null
    ydoc?.destroy()
    ydoc = null
    ynodes = null
    yimages = null
    suppressGraphSync = false
    suppressYjsEvents = false
    snapshot = disconnectedSnapshot()
    onChange(snapshot)
  }

  const handleMessage = async (data: unknown): Promise<void> => {
    const raw = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : null
    if (!raw || raw.byteLength === 0 || !ydoc) return
    const payload = raw.subarray(1)
    if (raw[0] === UPDATE_MESSAGE || raw[0] === SYNC_RESPONSE_MESSAGE) {
      Y.applyUpdate(ydoc, payload, REMOTE_ORIGIN)
      return
    }
    if (raw[0] === SYNC_REQUEST_MESSAGE) {
      send(SYNC_RESPONSE_MESSAGE, Y.encodeStateAsUpdate(ydoc, payload))
      return
    }
    if (raw[0] === PEER_COUNT_MESSAGE && payload.byteLength === 4) {
      publish({ peerCount: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0) })
    }
  }

  const connect = (
    target: CollaborationTarget,
    publishCurrentDocument: boolean,
    joinCodes: readonly string[],
  ): void => {
    ydoc = new Y.Doc()
    ynodes = ydoc.getMap('nodes')
    yimages = ydoc.getMap('images')
    ynodes.observeDeep(events => {
      if (suppressYjsEvents) return
      suppressGraphSync = true
      try {
        applyYjsEvents(events)
        editor.requestRender()
      } finally {
        suppressGraphSync = false
      }
    })
    yimages.observe(event => {
      if (suppressYjsEvents || !yimages) return
      for (const [hash, change] of event.changes.keys) {
        if (change.action === 'delete') editor.graph.images.delete(hash)
        else {
          const image = yimages.get(hash)
          if (image) editor.graph.images.set(hash, new Uint8Array(image))
        }
      }
      editor.requestRender()
    })
    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE_ORIGIN) send(UPDATE_MESSAGE, update)
    })
    unbindGraphEvents = bindGraphEvents()
    if (publishCurrentDocument) syncDocument()

    const current = new WebSocket(target.socketURL)
    current.binaryType = 'arraybuffer'
    socket = current
    publish({ active: true, connected: false, roomId: target.roomToken, peerCount: 0, joinCodes })
    current.onopen = () => {
      if (socket !== current || !ydoc) return
      publish({ connected: true, peerCount: 1 })
      if (publishCurrentDocument) send(UPDATE_MESSAGE, Y.encodeStateAsUpdate(ydoc))
      send(SYNC_REQUEST_MESSAGE, Y.encodeStateVector(ydoc))
    }
    current.onmessage = event => { void handleMessage(event.data) }
    current.onerror = () => { current.close() }
    current.onclose = () => {
      if (socket !== current) return
      const ownedHost = hostKey
      hostKey = null
      resetLocal()
      if (ownedHost) void hostBridge.stop(ownedHost)
    }
  }

  const leave = async (): Promise<void> => {
    const ownedHost = hostKey
    hostKey = null
    resetLocal()
    if (ownedHost) await hostBridge.stop(ownedHost)
  }

  return {
    isActive: () => snapshot.active,
    share: async () => {
      await leave()
      const hosted = await hostBridge.start()
      hostKey = hosted.hostKey
      connect({ socketURL: hosted.localSocketURL, roomToken: hosted.roomToken }, true, hosted.joinCodes)
      return hosted.joinCodes
    },
    join: async (value) => {
      const target = parseCollaborationJoinCode(value)
      if (!target) throw new Error('请输入有效的 OpenPencil 内网连接码')
      await leave()
      connect(target, false, [target.joinCode])
      return target.joinCode
    },
    leave,
  }
}

interface CollaborationTarget {
  readonly socketURL: string
  readonly roomToken: string
}

interface ParsedCollaborationTarget extends CollaborationTarget {
  readonly joinCode: string
}

function disconnectedSnapshot(): CollaborationSnapshot {
  return { active: false, connected: false, roomId: null, peerCount: 0, joinCodes: [] }
}

function syncNodeProps(node: SceneNode, target: Y.Map<unknown>): void {
  for (const [key, value] of Object.entries(node)) target.set(key, structuredClone(value))
}

function yNodeToProps(source: Y.Map<unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const [key, value] of source.entries()) props[key] = structuredClone(value)
  return props
}

export function parseCollaborationJoinCode(value: string): ParsedCollaborationTarget | null {
  try {
    const url = new URL(value.trim())
    const roomToken = url.pathname.replace(/^\//u, '')
    const port = Number(url.port)
    if (
      url.protocol !== 'openpencil-lan:'
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
      || !isPrivateIPv4(url.hostname)
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || !ROOM_TOKEN_PATTERN.test(roomToken)
    ) return null
    const joinCode = `openpencil-lan://${url.hostname}:${port}/${roomToken}`
    return {
      socketURL: `ws://${url.hostname}:${port}${COLLABORATION_PATH}${roomToken}`,
      roomToken,
      joinCode,
    }
  } catch {
    return null
  }
}

export function isPrivateIPv4(value: string): boolean {
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [first = Number.NaN, second = Number.NaN] = octets
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
}
