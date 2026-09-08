import { describe, expect, it } from 'vitest'
import { getSharedStyles, type Fill } from '@open-pencil/scene-graph'
import { getWorldMatrix } from '@open-pencil/scene-graph/coordinate'
import { transformVectorNetwork } from '@open-pencil/scene-graph'
import { createSessionEditor } from '../src/session-document.ts'
import { editSharedStyle } from '../src/shared-styles.ts'
import { finishVectorEdit, flushVectorEdit, vectorEditing } from '../src/vector-edit/adapter.ts'

const blue: Fill = { type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true }

describe('shared styles', () => {
  it('creates, propagates, detaches and restores definitions through document history', () => {
    const editor = createSessionEditor()
    const page = editor.state.currentPageId
    const source = editor.graph.createNode('RECTANGLE', page, { fills: [blue] })
    const target = editor.graph.createNode('RECTANGLE', page)
    const created = editSharedStyle(editor, { action: 'create', kind: 'fill', node_id: source.id, name: 'Brand/Primary' }) as { style_id: string }
    expect(getSharedStyles(editor.graph, 'fill')).toHaveLength(1)
    expect(editor.getLayerTree().map(node => node.id)).not.toContain(created.style_id)
    editSharedStyle(editor, { action: 'apply', kind: 'fill', style_id: created.style_id, node_ids: [target.id] })
    expect(editor.graph.getNode(target.id)?.fills).toEqual([blue])
    editor.updateNodeWithUndo(source.id, { fills: [{ ...blue, color: { r: 1, g: 0, b: 0, a: 1 } }] })
    editSharedStyle(editor, { action: 'update', kind: 'fill', style_id: created.style_id, node_id: source.id })
    expect(editor.graph.getNode(target.id)?.fills[0].color.r).toBe(1)
    editSharedStyle(editor, { action: 'delete', kind: 'fill', style_id: created.style_id })
    expect(editor.graph.getNode(target.id)?.fillStyleId).toBeNull()
    expect(editor.graph.getNode(target.id)?.fills[0].color.r).toBe(1)
    editor.undoAction()
    expect(getSharedStyles(editor.graph, 'fill')).toHaveLength(1)
    expect(editor.graph.getNode(target.id)?.fillStyleId).toBe(created.style_id)
    editor.undoAction()
    expect(editor.graph.getNode(target.id)?.fills).toEqual([blue])
  })
})

describe('official vector editing adapter', () => {
  it('commits nested rotated anchors without changing their world position and keeps undo/redo', () => {
    const editor = createSessionEditor()
    const frame = editor.graph.createNode('FRAME', editor.state.currentPageId, { x: 100, y: 80, width: 400, height: 300, rotation: 20 })
    const node = editor.graph.createNode('VECTOR', frame.id, {
      x: 20, y: 30, width: 100, height: 80, rotation: 35, fills: [blue],
      vectorNetwork: { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 80 }], segments: [
        { start: 0, end: 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
        { start: 1, end: 2, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
        { start: 2, end: 0, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }
      ], regions: [{ windingRule: 'NONZERO', loops: [[0, 1, 2]] }] }
    })
    const vector = vectorEditing(editor)!
    vector.enterNodeEditMode(node.id)
    const edit = vector.getNodeEditState()!
    const originalX = edit.vertices[0].x
    vector.nodeEditPushHistory()
    edit.vertices[0].x += 20
    const expected = edit.vertices.map(v => ({ ...v }))
    flushVectorEdit(editor)
    const world = transformVectorNetwork(getWorldMatrix(node, editor.graph), node.vectorNetwork!)
    world.vertices.forEach((v, i) => { expect(v.x).toBeCloseTo(expected[i].x); expect(v.y).toBeCloseTo(expected[i].y) })
    vector.nodeEditUndo()
    flushVectorEdit(editor)
    expect(edit.vertices[0].x).toBeCloseTo(originalX)
    vector.nodeEditRedo()
    flushVectorEdit(editor)
    expect(edit.vertices[0].x).toBeCloseTo(expected[0].x)
    finishVectorEdit(editor)
    expect(editor.state.nodeEditState).toBeNull()
    editor.undoAction()
    const undone = editor.graph.getNode(node.id)!
    expect(transformVectorNetwork(getWorldMatrix(undone, editor.graph), undone.vectorNetwork!).vertices[0].x).toBeCloseTo(originalX)
  })

  it('remaps both endpoints correctly when joining a higher numbered endpoint', () => {
    const editor = createSessionEditor()
    const node = editor.graph.createNode('VECTOR', editor.state.currentPageId, {
      vectorNetwork: { vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }, { x: 60, y: 0 }], regions: [], segments: [
        { start: 0, end: 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
        { start: 2, end: 3, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }
      ] }
    })
    const vector = vectorEditing(editor)!
    vector.enterNodeEditMode(node.id)
    vector.nodeEditConnectEndpoints(1, 2)
    const edit = vector.getNodeEditState()!
    expect(edit.vertices).toHaveLength(3)
    expect(edit.segments.map(s => [s.start, s.end])).toEqual([[0, 1], [1, 2]])
    finishVectorEdit(editor)
  })
})
