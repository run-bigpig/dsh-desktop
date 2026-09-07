import type { Editor } from '@open-pencil/core/editor'
import { SceneGraph } from '@open-pencil/scene-graph'

// MCP edits can span pages and document variables. A page-only snapshot loses
// those changes. Reconstruct through SceneGraph's public creation APIs so its
// component index is rebuilt, then use the Editor's graph replacement lifecycle.
export function snapshotDocument(editor: Editor) {
  const graph = editor.graph
  return {
    nodes: structuredClone([...graph.getAllNodes()]),
    images: new Map(graph.images),
    variables: structuredClone([...graph.variables.values()]),
    collections: structuredClone([...graph.variableCollections.values()]),
    activeModes: new Map(graph.activeMode),
    rootId: graph.rootId,
    figKiwiVersion: graph.figKiwiVersion,
    figSchemaDeflated: graph.figSchemaDeflated,
    documentColorSpace: graph.documentColorSpace,
    pageId: editor.state.currentPageId,
    selection: [...editor.state.selectedIds],
    viewport: { panX: editor.state.panX, panY: editor.state.panY, zoom: editor.state.zoom }
  }
}

export function restoreDocumentSnapshot(editor: Editor, snapshot: ReturnType<typeof snapshotDocument>): void {
  const graph = new SceneGraph()
  for (const page of graph.getPages()) graph.deleteNode(page.id)
  graph.deleteNode(graph.rootId)
  graph.rootId = snapshot.rootId
  graph.figKiwiVersion = snapshot.figKiwiVersion
  graph.figSchemaDeflated = snapshot.figSchemaDeflated
  graph.documentColorSpace = snapshot.documentColorSpace
  for (const node of snapshot.nodes) {
    graph.createNodeWithId(node.id, node.type, null, { ...structuredClone(node), parentId: null, childIds: [] })
  }
  for (const node of snapshot.nodes) {
    for (const id of node.childIds) graph.reparentNode(id, node.id)
  }
  for (const [hash, bytes] of snapshot.images) graph.images.set(hash, bytes)
  for (const collection of snapshot.collections) graph.addCollection(structuredClone(collection))
  for (const variable of snapshot.variables) graph.addVariable(structuredClone(variable))
  for (const [collectionId, modeId] of snapshot.activeModes) graph.setActiveMode(collectionId, modeId)
  editor.replaceGraph(graph)
  if (graph.getNode(snapshot.pageId)?.type === 'CANVAS') editor.switchPage(snapshot.pageId)
  editor.select(snapshot.selection.filter(id => graph.getNode(id)))
  Object.assign(editor.state, snapshot.viewport)
  editor.requestRender()
}
