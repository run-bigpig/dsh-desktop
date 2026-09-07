import { createEditor } from '@open-pencil/core/editor'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/session-document.ts', () => ({
  encodeSessionDocument: vi.fn().mockResolvedValue('AQIDBA==')
}))

import { startBridge } from '../src/bridge.ts'
import type { DesignSession } from '../src/runtime.ts'

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []

  readonly OPEN = FakeWebSocket.OPEN
  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  private listeners = new Map<string, Array<(event: any) => void>>()

  constructor(readonly url: URL) { FakeWebSocket.instances.push(this) }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(value: string): void { this.sent.push(value) }
  close(): void { this.readyState = 3 }
  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function createSession(): DesignSession {
  const editor = createEditor()
  return {
    connection: { baseUrl: 'http://127.0.0.1:7600/', sessionId: 'design-test', token: 'token' },
    document: { editor, name: 'test.fig', savedVersion: -1 },
    generation: 1,
    revision: 0,
    bridgePhase: 'disconnected',
    bridgeDetail: '',
    mounts: 1,
    restoreDocument: vi.fn(),
    persistenceError: ''
  }
}

afterEach(() => {
  FakeWebSocket.instances = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('design bridge', () => {
  it('synchronizes Agent selection and page navigation with the visible editor', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 })
    const session = createSession()
    const editor = session.document!.editor
    const original = editor.state.currentPageId
    const rect = editor.graph.createNode('RECTANGLE', original)
    const page = editor.graph.addPage('Second')
    const stop = startBridge(session)
    const socket = FakeWebSocket.instances[0]
    await callTool(socket, 'select_nodes', { ids: [rect.id] })
    expect([...editor.state.selectedIds]).toEqual([rect.id])
    await callTool(socket, 'switch_page', { page: page.id })
    expect(editor.state.currentPageId).toBe(page.id)
    expect(editor.state.selectedIds.size).toBe(0)
    stop()
  })

  it('creates variables and collections without treating their IDs as node IDs and supports undo', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 })
    const session = createSession()
    const editor = session.document!.editor
    const stop = startBridge(session)
    const socket = FakeWebSocket.instances[0]
    const collection = await callTool(socket, 'create_collection', { name: 'Theme' })
    expect(collection.ok).toBe(true)
    const variable = await callTool(socket, 'create_variable', { name: 'Brand', type: 'COLOR', collection_id: collection.result.id, value: '#0000FF' })
    expect(variable.ok).toBe(true)
    expect(editor.graph.variables.get(variable.result.id)?.name).toBe('Brand')
    editor.undoAction()
    expect(editor.graph.variables.has(variable.result.id)).toBe(false)
    expect(editor.graph.variableCollections.has(collection.result.id)).toBe(true)
    editor.redoAction()
    expect(editor.graph.variables.has(variable.result.id)).toBe(true)
    stop()
  })

  it('rolls back a partial batch and reports read-tool errors as failed calls', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 })
    const session = createSession()
    const editor = session.document!.editor
    const node = editor.graph.createNode('RECTANGLE', editor.state.currentPageId, { name: 'Original' })
    const stop = startBridge(session)
    const socket = FakeWebSocket.instances[0]
    const batch = await callTool(socket, 'batch_update', { operations: JSON.stringify([
      { id: node.id, props: { name: 'Changed' } }, { id: 'missing', props: { name: 'Missing' } }
    ]) })
    expect(batch.ok).toBe(false)
    expect(editor.graph.getNode(node.id)?.name).toBe('Original')
    const read = await callTool(socket, 'get_node', { id: 'missing' })
    expect(read.ok).toBe(false)
    stop()
  })

  it('does not overwrite a saved document or run Agent edits when restoration fails', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 })
    const session = createSession()
    session.restoreDocument = vi.fn().mockRejectedValue(new Error('Invalid snapshot'))
    const stop = startBridge(session)
    const socket = FakeWebSocket.instances[0]
    socket.emit('message', { data: JSON.stringify({ type: 'registered', persistence: true, document: { name: 'Saved.fig', data: 'AQIDBA==' } }) })
    await vi.waitFor(() => expect(session.bridgePhase).toBe('error'))
    const result = await callTool(socket, 'create_shape', { type: 'RECTANGLE', x: 0, y: 0, width: 200, height: 100 })
    expect(result.ok).toBe(false)
    expect(session.document!.editor.graph.getChildren(session.document!.editor.state.currentPageId)).toEqual([])
    expect(socket.sent.some(raw => JSON.parse(raw).type === 'persist_document')).toBe(false)
    stop()
  })

  it('commits a created node before responding so the next mutation can use it', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 })
    const session = createSession()
    const stop = startBridge(session)
    const socket = FakeWebSocket.instances[0]

    socket.emit('message', { data: JSON.stringify({
      type: 'request', id: 'create', command: 'tool', args: {
        document_id: 'design-test', name: 'create_shape',
        args: { type: 'RECTANGLE', x: 10, y: 20, width: 200, height: 100, name: 'Rectangle' }
      }
    }) })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const created = JSON.parse(socket.sent[0])
    const id = created.result.id as string
    expect(session.document?.editor.graph.getNode(id)?.parentId)
      .toBe(session.document?.editor.state.currentPageId)
    expect(session.document?.editor.state.selectedIds.has(id)).toBe(true)

    socket.emit('message', { data: JSON.stringify({
      type: 'request', id: 'fill', command: 'tool', args: {
        document_id: 'design-test', name: 'set_fill', args: { id, color: '#0000ff' }
      }
    }) })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(JSON.parse(socket.sent[1])).toMatchObject({ id: 'fill', ok: true })
    expect(session.document?.editor.graph.getNode(id)?.fills[0]).toMatchObject({
      type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }
    })

    session.document?.editor.undoAction(() => {})
    expect(session.document?.editor.graph.getNode(id)?.fills[0]).not.toMatchObject({
      type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }
    })
    session.document?.editor.undoAction(() => {})
    expect(session.document?.editor.graph.getNode(id)).toBeUndefined()
    session.document?.editor.redoAction(() => {})
    session.document?.editor.redoAction(() => {})
    expect(session.document?.editor.graph.getNode(id)?.fills[0]).toMatchObject({
      type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }
    })
    stop()
  })

  it('does not fight another window for a replaced session connection', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const session = createSession()
    startBridge(session)
    FakeWebSocket.instances[0].emit('close', { code: 4001 })
    vi.advanceTimersByTime(5000)

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(session.bridgeDetail).toBe('当前设计已在另一个窗口中打开')
  })

  it('waits for the session snapshot to be durable before acknowledging an Agent mutation', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 })
    vi.stubGlobal('crypto', { randomUUID: () => 'persist-1' })
    const session = createSession()
    const stop = startBridge(session)
    const socket = FakeWebSocket.instances[0]
    socket.emit('message', { data: JSON.stringify({ type: 'registered', persistence: true }) })

    socket.emit('message', { data: JSON.stringify({
      type: 'request', id: 'create', command: 'tool', args: {
        document_id: 'design-test', name: 'create_shape',
        args: { type: 'RECTANGLE', x: 10, y: 20, width: 200, height: 100, name: 'Persisted' }
      }
    }) })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: 'persist_document',
      id: 'persist-1',
      document: { name: 'test.fig', data: 'AQIDBA==' }
    })

    socket.emit('message', { data: JSON.stringify({ type: 'persisted', id: 'persist-1' }) })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(JSON.parse(socket.sent[1])).toMatchObject({ type: 'response', id: 'create', ok: true })
    stop()
  })
})

async function callTool(socket: FakeWebSocket, name: string, args: Record<string, unknown>) {
  const id = `call-${socket.sent.length}`
  socket.emit('message', { data: JSON.stringify({
    type: 'request', id, command: 'tool', args: { document_id: 'design-test', name, args }
  }) })
  await vi.waitFor(() => expect(socket.sent.some(raw => JSON.parse(raw).id === id)).toBe(true))
  return JSON.parse(socket.sent.find(raw => JSON.parse(raw).id === id)!)
}
