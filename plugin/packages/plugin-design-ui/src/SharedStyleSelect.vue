<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { MIXED, useEditor, useSharedStyleBinding } from '@open-pencil/vue'
import Plus from '~icons/lucide/plus'
import Pencil from '~icons/lucide/pencil'
import Refresh from '~icons/lucide/refresh-cw'
import Trash from '~icons/lucide/trash-2'
import { editSharedStyle, type SharedStyleOperation } from './shared-styles.ts'
const props = defineProps<{ kind: 'fill' | 'stroke' | 'text' | 'effect' | 'grid' }>()
const editor = useEditor()
const binding = useSharedStyleBinding(props.kind)
const error = ref('')
const managedId = ref('')
watch(binding.styleId, id => { if (typeof id === 'string') managedId.value = id }, { immediate: true })
const selected = computed(() => binding.styles.value.find(style => style.id === managedId.value))
const missing = computed(() => typeof binding.styleId.value === 'string' && !binding.styles.value.some(style => style.id === binding.styleId.value))
function run(action: SharedStyleOperation['action']): void {
  let name: string | undefined
  if (action === 'create' || action === 'rename') {
    const input = window.prompt('样式名称', action === 'rename' ? selected.value?.name : editor.getSelectedNode()?.name)
    if (input === null) return
    name = input
  }
  if (action === 'delete' && !window.confirm('删除此样式？已使用的图层保留当前外观并解除绑定。')) return
  try {
    editSharedStyle(editor, { action, kind: props.kind, name, style_id: selected.value?.id })
    error.value = ''
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
</script>

<template>
  <div v-if="binding.active.value" class="shared-style-field" :data-style-kind="kind">
    <label class="style-select">样式
      <select :aria-label="`${kind} 样式`" :value="binding.styleId.value === MIXED ? '__mixed__' : binding.styleId.value ?? ''" @change="($event.target as HTMLSelectElement).value ? binding.bind(($event.target as HTMLSelectElement).value) : binding.unbind()">
        <option value="">自定义</option><option v-if="binding.styleId.value === MIXED" value="__mixed__" disabled>混合样式</option><option v-if="missing" :value="binding.styleId.value as string" disabled>样式缺失</option><option v-for="style in binding.styles.value" :key="style.id" :value="style.id">{{ style.name }}</option>
      </select>
      <button type="button" class="icon-action" aria-label="从选中图层创建样式" title="从选中图层创建样式" :disabled="editor.state.selectedIds.size !== 1" @click="run('create')"><Plus /></button>
    </label>
    <details v-if="binding.styles.value.length" class="style-manager">
      <summary>管理样式</summary>
      <select v-model="managedId" aria-label="管理样式"><option value="" disabled>选择样式</option><option v-for="style in binding.styles.value" :key="style.id" :value="style.id">{{ style.name }}</option></select>
    <div v-if="selected" class="style-actions">
      <button type="button" class="icon-action" aria-label="重命名样式" title="重命名样式" @click="run('rename')"><Pencil /></button>
      <button type="button" class="icon-action" aria-label="用选中图层更新样式" title="用选中图层更新所有绑定图层" :disabled="editor.state.selectedIds.size !== 1" @click="run('update')"><Refresh /></button>
      <button type="button" class="icon-action" aria-label="删除样式" title="删除样式" @click="run('delete')"><Trash /></button>
    </div>
    </details>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
  </div>
</template>
