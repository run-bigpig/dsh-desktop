// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorInput } from '../src/editor-input.ts'
import { createSessionEditor } from '../src/session-document.ts'
import type { useEditorCommands } from '@open-pencil/vue'

afterEach(() => { document.body.replaceChildren() })

describe('editor keyboard scope', () => {
  it('handles canvas shortcuts but leaves shadow inputs and the Harness composer alone', () => {
    const editor = createSessionEditor()
    const commands = { commands: {}, runCommand: vi.fn() } as unknown as ReturnType<typeof useEditorCommands>
    const { keydown } = createEditorInput(editor, commands, vi.fn())
    const workspace = document.createElement('section')
    const canvas = document.createElement('canvas')
    workspace.append(canvas)
    workspace.addEventListener('keydown', keydown)
    document.body.append(workspace)
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true, cancelable: true }))
    expect(editor.state.activeTool).toBe('RECTANGLE')
    const shadow = document.createElement('div')
    workspace.append(shadow)
    const input = document.createElement('input')
    shadow.attachShadow({ mode: 'open' }).append(input)
    const typing = new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true, composed: true, cancelable: true })
    input.dispatchEvent(typing)
    expect(typing.defaultPrevented).toBe(false)
    expect(editor.state.activeTool).toBe('RECTANGLE')
    const composer = document.createElement('textarea')
    document.body.append(composer)
    composer.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }))
    expect(editor.state.activeTool).toBe('RECTANGLE')
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }))
    expect(editor.state.activeTool).toBe('SELECT')
  })

  it('nudges selected nodes with undo and ignores IME composition', () => {
    const editor = createSessionEditor()
    const commands = { commands: {}, runCommand: vi.fn() } as unknown as ReturnType<typeof useEditorCommands>
    const { keydown, keyup } = createEditorInput(editor, commands, vi.fn())
    const canvas = document.createElement('canvas')
    canvas.addEventListener('keydown', keydown)
    canvas.addEventListener('keyup', keyup)
    document.body.append(canvas)
    const node = editor.graph.createNode('RECTANGLE', editor.state.currentPageId, { x: 20 })
    editor.select([node.id])
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', shiftKey: true }))
    expect(editor.graph.getNode(node.id)?.x).toBe(30)
    canvas.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight' }))
    editor.undoAction()
    expect(editor.graph.getNode(node.id)?.x).toBe(20)
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', isComposing: true }))
    expect(editor.state.activeTool).toBe('SELECT')
  })
})
