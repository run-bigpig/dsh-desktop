<script setup lang="ts">
import { computed } from 'vue'
import { useEditor } from '@open-pencil/vue'
import Pen from '~icons/lucide/pen-tool'
import Check from '~icons/lucide/check'
import Undo from '~icons/lucide/undo-2'
import Redo from '~icons/lucide/redo-2'
import Scissors from '~icons/lucide/scissors'
import Trash from '~icons/lucide/trash-2'
import { flushVectorEdit, vectorEditing } from './vector-edit/adapter.ts'
const props = defineProps<{ revision: number }>()
const editor = useEditor()
const vector = vectorEditing(editor)
const editing = computed(() => { void props.revision; return vector?.getNodeEditState() })
const node = computed(() => { void props.revision; return editor.getSelectedNode() })
function run(action: () => void): void { action(); flushVectorEdit(editor) }
</script>

<template>
  <div v-if="vector && (editing || node?.type === 'VECTOR')" class="vector-edit-bar" role="toolbar" aria-label="路径编辑">
    <template v-if="editing">
      <span>路径 · {{ editing.selectedVertexIndices.size }} 个锚点</span>
      <button type="button" class="icon-action" aria-label="撤销路径编辑" title="撤销路径编辑" :disabled="!editing.history.length" @click="run(vector.nodeEditUndo)"><Undo /></button>
      <button type="button" class="icon-action" aria-label="重做路径编辑" title="重做路径编辑" :disabled="!editing.future.length" @click="run(vector.nodeEditRedo)"><Redo /></button>
      <button type="button" class="icon-action" aria-label="断开锚点" title="断开选中锚点" :disabled="!editing.selectedVertexIndices.size" @click="run(vector.nodeEditBreakAtVertex)"><Scissors /></button>
      <button type="button" class="icon-action" aria-label="删除锚点" title="删除选中锚点或手柄" :disabled="!editing.selectedVertexIndices.size && !editing.selectedHandles.size" @click="run(vector.nodeEditDeleteSelected)"><Trash /></button>
      <button type="button" class="compact-action" @click="vector.exitNodeEditMode(true)"><Check />完成路径</button>
    </template>
    <button v-else-if="node" type="button" class="compact-action" @click="vector.enterNodeEditMode(node.id)"><Pen />编辑路径</button>
  </div>
</template>
