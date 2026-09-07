import { TOOL_SHORTCUTS, type Editor } from '@open-pencil/core/editor'
import { editorCommandMetadata, extractImageFilesFromClipboard, type EditorCommandId, type useEditorCommands } from '@open-pencil/vue'
import { flushVectorEdit, vectorEditing } from './vector-edit/adapter.ts'

export function isEditingTarget(event: Event): boolean {
  return event.composedPath().some(target => target instanceof HTMLElement
    && (target.matches('input, textarea, select') || target.isContentEditable))
}

export function matchesKeybinding(event: KeyboardEvent, binding: string): boolean {
  const parts = binding.split('+')
  return parts.at(-1) === event.code
    && (parts.includes('$mod') ? event.ctrlKey || event.metaKey : event.ctrlKey === parts.includes('Control') && event.metaKey === parts.includes('Meta'))
    && event.shiftKey === parts.includes('Shift')
    && event.altKey === parts.includes('Alt')
}

// Bound to the plugin's editor DOM, never to the Harness window or composer.
export function createEditorInput(editor: Editor, commands: ReturnType<typeof useEditorCommands>, reportError: (error: unknown) => void) {
  function keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || isEditingTarget(event) || editor.state.editingTextId) return
    if (!event.code.startsWith('Arrow')) editor.flushNudge()
    const vector = vectorEditing(editor)
    const edit = vector?.getNodeEditState()
    if (edit && vector) {
      let handled = true
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
        if (event.shiftKey) vector.nodeEditRedo()
        else vector.nodeEditUndo()
      } else if ((event.ctrlKey || event.metaKey) && event.code === 'KeyA') {
        edit.selectedVertexIndices = new Set(edit.vertices.map((_, index) => index))
        editor.requestRepaint()
      } else if (event.code === 'Delete' || event.code === 'Backspace') vector.nodeEditDeleteSelected()
      else if (event.code === 'Enter' || event.code === 'Escape') vector.exitNodeEditMode(true)
      else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.code.startsWith('Arrow')) {
        const offset = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.code as 'ArrowLeft']
        if (offset && edit.selectedVertexIndices.size) {
          vector.nodeEditPushHistory()
          for (const index of edit.selectedVertexIndices) {
            const vertex = edit.vertices[index]
            edit.vertices[index] = { ...vertex, x: vertex.x + offset[0] * (event.shiftKey ? 10 : 1), y: vertex.y + offset[1] * (event.shiftKey ? 10 : 1) }
          }
          editor.requestRepaint()
        }
      }
      else handled = false
      if (handled) { flushVectorEdit(editor); event.preventDefault(); event.stopPropagation(); return }
    }
    let handled = true
    const command = (Object.keys(commands.commands) as EditorCommandId[]).find(id => {
      const bindings = editorCommandMetadata(id).keybinding
      return (typeof bindings === 'string' ? [bindings] : bindings ?? []).some(binding => matchesKeybinding(event, binding))
    })
    if (command) commands.runCommand(command)
    else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const tool = !event.shiftKey ? TOOL_SHORTCUTS[event.code] : undefined
      if (tool) editor.setTool(tool)
      else if (event.code === 'Delete' || event.code === 'Backspace') {
        commands.runCommand('selection.delete')
      } else if (event.code === 'Escape') {
        if (editor.state.penState) editor.penCancel()
        else if (editor.state.enteredContainerId) editor.exitContainer()
        else { editor.clearSelection(); editor.setTool('SELECT') }
      } else if (event.code === 'Enter') {
        if (editor.state.penState) editor.penCommit(false)
        else {
          const node = editor.getSelectedNode()
          if (node?.type === 'TEXT') editor.startTextEditing(node.id)
          else if (node?.type === 'VECTOR') vector?.enterNodeEditMode(node.id)
        }
      } else {
        const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
        const offset = delta[event.code]
        if (offset && editor.state.selectedIds.size) {
          const step = event.shiftKey ? 10 : 1
          editor.nudgeSelected(offset[0] * step, offset[1] * step)
        } else handled = false
      }
    } else handled = false
    if (handled) { event.preventDefault(); event.stopPropagation() }
  }

  function keyup(event: KeyboardEvent): void {
    if (event.code.startsWith('Arrow')) editor.flushNudge()
  }

  async function clipboard(event: ClipboardEvent): Promise<void> {
    if (isEditingTarget(event) || editor.state.editingTextId || !event.clipboardData) return
    try {
      if (event.type === 'copy' || event.type === 'cut') {
        if (!editor.state.selectedIds.size) return
        event.preventDefault(); event.stopPropagation()
        await editor.writeCopyData(event.clipboardData)
        if (event.type === 'cut') editor.deleteSelected()
      } else {
        const files = extractImageFilesFromClipboard(event)
        const html = event.clipboardData.getData('text/html')
        if (!files.length && !html) return
        event.preventDefault(); event.stopPropagation()
        if (files.length) {
          const width = editor.renderer?.viewportWidth ?? 0
          const height = editor.renderer?.viewportHeight ?? 0
          const center = editor.screenToCanvas(width / 2, height / 2)
          await editor.placeImageFiles(files, center.x, center.y)
        } else await editor.pasteFromHTML(html)
      }
    } catch (error) { reportError(error) }
  }
  return { keydown, keyup, clipboard }
}
