import type { Editor } from '@open-pencil/core/editor'
import { getSharedStyles, sharedStyleRefKey, sharedStyleTypeForKind, type SceneNode, type SharedStyleKind } from '@open-pencil/scene-graph'
import { restoreDocumentSnapshot, snapshotDocument } from './document-history.ts'

const kinds: SharedStyleKind[] = ['fill', 'stroke', 'text', 'effect', 'grid']
const textKeys = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase', 'fontFeatures'] as const

function supports(node: SceneNode | undefined, kind: SharedStyleKind): node is SceneNode {
  if (!node || node.internalOnly || node.type === 'CANVAS') return false
  if (kind === 'text') return node.type === 'TEXT'
  if (kind === 'grid') return ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(node.type)
  return true
}

function payload(kind: SharedStyleKind, node: SceneNode): Partial<SceneNode> {
  if (kind === 'fill') return { fills: structuredClone(node.fills) }
  if (kind === 'stroke') return { fills: node.strokes.map(stroke => ({ type: 'SOLID', color: { ...stroke.color }, opacity: stroke.opacity, visible: stroke.visible })) }
  if (kind === 'effect') return { effects: structuredClone(node.effects) }
  if (kind === 'grid') return { layoutGrids: structuredClone(node.layoutGrids) }
  return Object.fromEntries(textKeys.map(key => [key, structuredClone(node[key])]))
}

function apply(kind: SharedStyleKind, target: SceneNode, style: SceneNode): Partial<SceneNode> {
  const ref = { [sharedStyleRefKey(kind)]: style.source.id }
  if (kind !== 'stroke') return { ...payload(kind, style), ...ref }
  const fills = style.fills.filter(fill => fill.type === 'SOLID')
  if (!fills.length) return { ...ref, strokes: structuredClone(target.strokes) }
  const fallback = target.strokes[0] ?? { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, opacity: 1, visible: true, align: 'CENTER' as const }
  return { ...ref, strokes: fills.map((fill, index) => ({ ...(target.strokes[index] ?? fallback), color: { ...fill.color }, opacity: fill.opacity, visible: fill.visible })) }
}

export interface SharedStyleOperation {
  action: 'list' | 'create' | 'update' | 'rename' | 'delete' | 'apply' | 'detach'
  kind: SharedStyleKind
  style_id?: string
  node_id?: string
  node_ids?: string[]
  name?: string
}

// Style definitions are official internal SceneNodes, so .fig IO and imported
// styles share the same identity and property references as the public SDK.
export function editSharedStyle(editor: Editor, operation: SharedStyleOperation): unknown {
  const { action, kind } = operation
  if (!kinds.includes(kind)) throw new Error('无效的样式类型')
  const styles = getSharedStyles(editor.graph, kind)
  if (action === 'list') return { styles }
  const info = styles.find(style => style.id === operation.style_id)
  const style = info ? editor.graph.getNode(info.nodeId) : undefined
  if (action !== 'create' && action !== 'detach' && !style) throw new Error('找不到指定样式')
  const source = operation.node_id ? editor.graph.getNode(operation.node_id) : editor.getSelectedNode()
  if ((action === 'create' || action === 'update') && !supports(source, kind)) throw new Error('请选择一个适用于此样式的图层')
  const name = operation.name?.trim()
  if ((action === 'create' || action === 'rename') && !name) throw new Error('请输入样式名称')
  const targets = (operation.node_ids ?? [...editor.state.selectedIds]).map(id => editor.graph.getNode(id))
  if ((action === 'apply' || action === 'detach') && (!targets.length || targets.some(node => !supports(node, kind)))) throw new Error('请选择适用于此样式的图层')
  const before = snapshotDocument(editor)
  let result: unknown = { completed: action }
  try {
    if (action === 'create') {
      const definition = editor.graph.createNode(kind === 'text' ? 'TEXT' : 'RECTANGLE', editor.graph.rootId, {
        ...payload(kind, source!), name, internalOnly: true, sharedStyleType: sharedStyleTypeForKind(kind)
      })
      definition.source.id = definition.id
      editor.updateNode(source!.id, apply(kind, source!, definition))
      result = { style_id: definition.source.id, name }
    } else if (action === 'rename') editor.updateNode(style!.id, { name })
    else if (action === 'update') {
      editor.updateNode(style!.id, payload(kind, source!))
      for (const node of editor.graph.getAllNodes()) {
        if (node.internalOnly) continue
        for (const bindingKind of kinds.filter(item => sharedStyleTypeForKind(item) === style!.sharedStyleType)) {
          if (node[sharedStyleRefKey(bindingKind)] === style!.source.id) editor.updateNode(node.id, apply(bindingKind, node, style!))
        }
      }
    } else if (action === 'delete') {
      for (const node of editor.graph.getAllNodes()) {
        const detach: Partial<SceneNode> = {}
        for (const bindingKind of kinds) {
          const key = sharedStyleRefKey(bindingKind)
          if (node[key] === style!.source.id) detach[key] = null
        }
        if (Object.keys(detach).length) editor.updateNode(node.id, detach)
      }
      editor.graph.deleteNode(style!.id)
    } else if (action === 'apply' || action === 'detach') {
      for (const node of targets) editor.updateNode(node!.id, action === 'apply' ? apply(kind, node!, style!) : { [sharedStyleRefKey(kind)]: null })
    } else throw new Error('无效的样式操作')
    editor.requestRender()
    const after = snapshotDocument(editor)
    editor.pushUndoEntry({ label: `Style: ${action}`, forward: () => restoreDocumentSnapshot(editor, after), inverse: () => restoreDocumentSnapshot(editor, before) })
    return result
  } catch (error) { restoreDocumentSnapshot(editor, before); throw error }
}
