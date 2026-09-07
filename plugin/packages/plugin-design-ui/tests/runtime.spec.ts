import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'

const { startBridge, stopBridge } = vi.hoisted(() => {
  const stop = vi.fn()
  return { stopBridge: stop, startBridge: vi.fn(() => stop) }
})

vi.mock('../src/bridge.ts', () => ({ startBridge }))

import { acquireSession, isDirty, releaseSession } from '../src/runtime.ts'
import { createSessionEditor } from '../src/session-document.ts'
import { restoreDocumentSnapshot, snapshotDocument } from '../src/document-history.ts'

beforeEach(() => vi.clearAllMocks())

describe('design session runtime', () => {
  it('flushes the last manual edit before disconnecting and preserves a remounted bridge', async () => {
    const connection = { baseUrl: 'http://127.0.0.1:7600/', sessionId: 'flush-on-switch', token: 'test-token' }
    const session = acquireSession(connection)
    let saved!: () => void
    session.bridgePhase = 'connected'
    session.persistNow = vi.fn(() => new Promise<void>(resolve => { saved = resolve }))
    const stop = vi.fn()
    session.stopBridge = stop
    releaseSession(session)
    expect(session.persistNow).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()
    acquireSession(connection)
    saved()
    await vi.waitFor(() => expect(session.mounts).toBe(1))
    expect(stop).not.toHaveBeenCalled()
    releaseSession(session)
    saved()
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    expect(session.stopBridge).toBeUndefined()
  })

  it('reacts to tool, selection, page and property updates through the SDK state', () => {
    const editor = createSessionEditor()
    const tool = computed(() => editor.state.activeTool)
    const selection = computed(() => [...editor.state.selectedIds])
    const page = computed(() => editor.state.currentPageId)
    const width = computed(() => {
      void editor.state.sceneVersion
      return editor.getSelectedNode()?.width
    })
    expect(tool.value).toBe('SELECT')
    expect(selection.value).toEqual([])
    const originalPage = page.value
    const rectangle = editor.graph.createNode('RECTANGLE', originalPage, { width: 100 })
    editor.select([rectangle.id])
    expect(width.value).toBe(100)
    editor.updateNodeWithUndo(rectangle.id, { width: 240 }, 'Resize')
    editor.setTool('ELLIPSE')
    expect(tool.value).toBe('ELLIPSE')
    expect(selection.value).toEqual([rectangle.id])
    expect(width.value).toBe(240)
    editor.addPage()
    expect(page.value).not.toBe(originalPage)
  })

  it('restores document-wide history including pages, variables and component indexes', () => {
    const editor = createSessionEditor()
    const page = editor.graph.getPages()[0]
    const component = editor.graph.createNode('COMPONENT', page.id, { name: 'Button' })
    const instance = editor.graph.createInstance(component.id, page.id)!
    const collection = editor.graph.createCollection('Colors')
    const variable = editor.graph.createVariable('Primary', 'COLOR', collection.id, { r: 0, g: 0, b: 1, a: 1 })
    const otherPage = editor.graph.addPage('Other')
    editor.switchPage(otherPage.id)
    const before = snapshotDocument(editor)
    editor.graph.deleteNode(component.id)
    editor.graph.removeCollection(collection.id)
    editor.graph.deleteNode(otherPage.id)
    restoreDocumentSnapshot(editor, before)
    expect(editor.graph.getPages().map(node => node.id)).toEqual([page.id, otherPage.id])
    expect(editor.state.currentPageId).toBe(otherPage.id)
    expect(editor.graph.getInstances(component.id).map(node => node.id)).toEqual([instance.id])
    expect(editor.graph.variableCollections.get(collection.id)?.variableIds).toEqual([variable.id])
    expect(editor.graph.variables.get(variable.id)?.name).toBe('Primary')
  })

  it('creates and connects a blank design when the canvas first mounts', () => {
    const session = acquireSession({
      baseUrl: 'http://127.0.0.1:7600/',
      sessionId: 'auto-blank-design',
      token: 'test-token'
    })

    expect(session.document?.name).toBe('未命名.fig')
    expect(isDirty(session)).toBe(true)
    expect(startBridge).toHaveBeenCalledOnce()

    releaseSession(session)
    expect(stopBridge).toHaveBeenCalledOnce()
  })

  it('keeps each Harness session in a separate SceneGraph', () => {
    const first = acquireSession({
      baseUrl: 'http://127.0.0.1:7600/', sessionId: 'isolated-a', token: 'token-a'
    })
    const second = acquireSession({
      baseUrl: 'http://127.0.0.1:7600/', sessionId: 'isolated-b', token: 'token-b'
    })
    const firstEditor = first.document!.editor
    const secondEditor = second.document!.editor
    const rectangle = firstEditor.graph.createNode('RECTANGLE', firstEditor.state.currentPageId, {
      name: 'Only in A', x: 10, y: 20, width: 100, height: 60
    })

    expect(firstEditor.graph.getNode(rectangle.id)?.name).toBe('Only in A')
    expect([...secondEditor.graph.getAllNodes()]).not.toContainEqual(expect.objectContaining({ name: 'Only in A' }))
    expect(first.document).not.toBe(second.document)

    releaseSession(first)
    releaseSession(second)
  })
})
