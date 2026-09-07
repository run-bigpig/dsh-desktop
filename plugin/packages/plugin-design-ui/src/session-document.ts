import { createDefaultEditorState, createEditor, type Editor } from '@open-pencil/core/editor'
import { BUILTIN_IO_FORMATS, IORegistry } from '@open-pencil/core/io'
import { SceneGraph } from '@open-pencil/scene-graph'
import { shallowReactive } from 'vue'
import { attachVectorEditing, flushVectorEdit } from './vector-edit/adapter.ts'

export const documentIO = new IORegistry(BUILTIN_IO_FORMATS)

export function createSessionEditor(graph?: SceneGraph): Editor {
  const scene = graph ?? new SceneGraph()
  let editor: Editor | undefined
  editor = createEditor({
    graph: scene,
    state: shallowReactive(createDefaultEditorState(scene.getPages()[0].id)),
    getViewportSize: () => ({
      width: editor?.renderer?.viewportWidth ?? window.innerWidth,
      height: editor?.renderer?.viewportHeight ?? window.innerHeight
    })
  })
  editor.state.pageColor = { r: 0.173, g: 0.173, b: 0.173, a: 1 }
  attachVectorEditing(editor)
  return editor
}

export async function encodeSessionDocument(editor: Editor): Promise<string> {
  flushVectorEdit(editor)
  const output = await documentIO.writeDocument('fig', editor.graph, {
    thumbnailPageId: editor.state.currentPageId,
    renderThumbnail: false
  })
  const bytes = typeof output.data === 'string' ? new TextEncoder().encode(output.data) : output.data
  return bytesToBase64(bytes)
}

export async function decodeSessionDocument(name: string, data: string): Promise<{ editor: Editor; name: string }> {
  const imported = await documentIO.readDocument({
    name: normalizeFigName(name),
    mimeType: 'application/octet-stream',
    data: base64ToBytes(data)
  })
  return { editor: createSessionEditor(imported.graph), name: normalizeFigName(name) }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function normalizeFigName(name: string): string {
  return /\.fig$/iu.test(name) ? name : `${name}.fig`
}
