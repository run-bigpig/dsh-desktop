import type { Editor } from '@open-pencil/core/editor'
import { createVectorEditActions } from './create.ts'
import type { VectorEditState } from './types.ts'

const actions = new WeakMap<Editor, ReturnType<typeof createVectorEditActions>>()

export function vectorEditing(editor: Editor) { return actions.get(editor) }

export function flushVectorEdit(editor: Editor): void {
  const vector = actions.get(editor)
  const state = vector?.getNodeEditState()
  if (state) vector!.applyNodeEditToNode(state)
}

export function finishVectorEdit(editor: Editor): void {
  actions.get(editor)?.exitNodeEditMode(true)
}

export function attachVectorEditing(editor: Editor): void {
  const state = editor.state as VectorEditState
  state.nodeEditState = null
  const vector = createVectorEditActions(editor, state)
  actions.set(editor, vector)
  // useCanvasInput invokes these app-layer methods when an anchor or handle is
  // hit. Keep the core Editor itself, including its live graph/renderer getters.
  Object.assign(editor, vector)
  const setTool = editor.setTool
  editor.setTool = tool => {
    if (!['SELECT', 'PEN', 'HAND'].includes(tool)) finishVectorEdit(editor)
    setTool(tool)
  }
  const select = editor.select
  editor.select = ids => {
    if (state.nodeEditState && !ids.includes(state.nodeEditState.nodeId)) finishVectorEdit(editor)
    select(ids)
  }
  const switchPage = editor.switchPage
  editor.switchPage = id => { finishVectorEdit(editor); return switchPage(id) }
  const replaceGraph = editor.replaceGraph
  editor.replaceGraph = graph => { state.nodeEditState = null; replaceGraph(graph) }
}
