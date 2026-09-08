// Adapted from open-pencil/open-pencil v0.14.0, src/app/editor/vector-edit/create.ts
// Copyright (c) 2026 Danila Poyarkov. MIT; see OPEN_PENCIL_LICENSE.
import type { Editor } from '@open-pencil/core/editor'

import { createVectorEditHandleActions } from './handle-actions.ts'
import { createVectorEditHistoryActions } from './history.ts'
import { createVectorEditLifecycle } from './lifecycle.ts'
import { createVectorEditNetworkActions, getLiveNetwork, setNodeEditNetwork } from './network.ts'
import { createVectorEditSelectionActions } from './selection.ts'
import type { VectorEditState } from './types.ts'

export function createVectorEditActions(editor: Editor, state: VectorEditState) {
  const { getNodeEditState, applyNodeEditToNode, enterNodeEditMode, exitNodeEditMode } =
    createVectorEditLifecycle(editor, state)
  const {
    nodeEditSelectVertex,
    nodeEditAlignVertices,
    nodeEditDeleteSelected,
    nodeEditBreakAtVertex
  } = createVectorEditSelectionActions(editor, state)

  const { nodeEditSetHandle, nodeEditBendHandle, nodeEditZeroVertexHandles } =
    createVectorEditHandleActions(editor, getNodeEditState)
  const { nodeEditPushHistory, nodeEditUndo, nodeEditRedo } = createVectorEditHistoryActions(
    editor,
    state
  )
  const { nodeEditConnectEndpoints, nodeEditAddVertex, nodeEditRemoveVertex } =
    createVectorEditNetworkActions(editor, state, getNodeEditState)

  return {
    getNodeEditState,
    setNodeEditNetwork,
    getLiveNetwork,
    applyNodeEditToNode,
    enterNodeEditMode,
    exitNodeEditMode,
    nodeEditSelectVertex,
    nodeEditSetHandle,
    nodeEditBendHandle,
    nodeEditZeroVertexHandles,
    nodeEditConnectEndpoints,
    nodeEditAddVertex,
    nodeEditRemoveVertex,
    nodeEditAlignVertices,
    nodeEditDeleteSelected,
    nodeEditBreakAtVertex,
    nodeEditPushHistory,
    nodeEditUndo,
    nodeEditRedo
  }
}
