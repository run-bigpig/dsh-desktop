<script setup lang="ts">
import { ref } from 'vue'
import { LayerTreeItem, useLayerTree, type LayerRow } from '@open-pencil/vue'
import ChevronRight from '~icons/lucide/chevron-right'
import ChevronDown from '~icons/lucide/chevron-down'
import Eye from '~icons/lucide/eye'
import EyeOff from '~icons/lucide/eye-off'
import Lock from '~icons/lucide/lock'
import LockOpen from '~icons/lucide/lock-open'
import { nodeIcon } from './icons.ts'

defineProps<{ row: LayerRow; expanded: boolean }>()
const tree = useLayerTree()
const renaming = ref(false)
const name = ref('')
function startRename(value: string): void { name.value = value; renaming.value = true }
function finishRename(id: string): void {
  if (!renaming.value) return
  if (name.value.trim()) tree.rename(id, name.value.trim())
  renaming.value = false
}
</script>

<template>
  <LayerTreeItem v-slot="{ isSelected, isDragging, actions }" :node="row.node" :level="row.level" :has-children="row.hasChildren">
    <div class="layer-row" :data-node-id="row.node.id" :class="{ selected: isSelected, dragging: isDragging, 'layer-hidden': !row.node.visible }"
      :style="{ paddingLeft: `${8 + row.level * 14}px` }" role="treeitem" tabindex="0"
      :aria-selected="isSelected" :aria-expanded="row.hasChildren ? expanded : undefined"
      :data-drop-position="tree.instructionTargetId.value === row.node.id ? tree.instruction.value?.type : undefined"
      @click="tree.select(row.node.id, { additive: $event.ctrlKey || $event.metaKey, range: $event.shiftKey })"
      @keydown.enter.prevent="tree.select(row.node.id, false)"
      @dblclick="startRename(row.node.name)">
      <button class="icon-action disclosure" :class="{ hidden: !row.hasChildren }" type="button" :aria-label="expanded ? '折叠图层' : '展开图层'" @click.stop="actions.toggleExpand">
        <component :is="expanded ? ChevronDown : ChevronRight" />
      </button>
      <component :is="nodeIcon(row.node)" class="layer-icon" aria-hidden="true" />
      <input v-if="renaming" :ref="el => (el as HTMLInputElement | null)?.focus()" v-model="name" class="layer-rename" aria-label="图层名称"
        @click.stop @keydown.stop @keydown.enter.prevent="finishRename(row.node.id)" @keydown.esc="renaming = false" @blur="finishRename(row.node.id)">
      <span v-else class="layer-name">{{ row.node.name }}</span>
      <button type="button" class="icon-action layer-action" :class="{ pinned: row.node.locked }" :aria-label="row.node.locked ? '解锁图层' : '锁定图层'" :title="row.node.locked ? '解锁图层' : '锁定图层'" @click.stop="actions.toggleLock"><component :is="row.node.locked ? Lock : LockOpen" /></button>
      <button type="button" class="icon-action layer-action" :class="{ pinned: !row.node.visible }" :aria-label="row.node.visible ? '隐藏图层' : '显示图层'" :title="row.node.visible ? '隐藏图层' : '显示图层'" @click.stop="actions.toggleVisibility"><component :is="row.node.visible ? Eye : EyeOff" /></button>
    </div>
  </LayerTreeItem>
</template>
