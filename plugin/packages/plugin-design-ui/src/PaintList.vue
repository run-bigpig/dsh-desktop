<script setup lang="ts">
import { useEditorPropertyList, useFillControls, useStrokeControls, useColorVariableBinding } from '@open-pencil/vue'
import Plus from '~icons/lucide/plus'
import Minus from '~icons/lucide/minus'
import Eye from '~icons/lucide/eye'
import EyeOff from '~icons/lucide/eye-off'
import PaintEditor from './PaintEditor.vue'
import SharedStyleSelect from './SharedStyleSelect.vue'

const props = defineProps<{ kind: 'fills' | 'strokes' }>()
const { items, isMixed, actions, flush, selectedNodeIds } = useEditorPropertyList(props.kind)
const { defaultFill } = useFillControls()
const { defaultStroke } = useStrokeControls()
const binding = useColorVariableBinding(props.kind)
function boundValue(index: number): string {
  void binding.store.state.sceneVersion
  return binding.getBindingState(selectedNodeIds.value, index) === 'mixed'
    ? '__mixed__'
    : binding.getBoundVariable(selectedNodeIds.value[0], index)?.id ?? ''
}
function bind(index: number, variableId: string): void {
  binding.store.undo.runBatch('Bind color variable', () => {
    for (const id of selectedNodeIds.value) {
      if (variableId) binding.bindVariable(id, index, variableId)
      else binding.unbindVariable(id, index)
    }
  })
}
</script>

<template>
  <section class="property-section" @focusout="flush">
    <header class="panel-header"><span>{{ kind === 'fills' ? '填充' : '描边' }}</span>
      <button type="button" class="icon-action" :aria-label="kind === 'fills' ? '添加填充' : '添加描边'" @click="actions.add(kind === 'fills' ? defaultFill : defaultStroke)"><Plus /></button>
    </header>
    <SharedStyleSelect :kind="kind === 'fills' ? 'fill' : 'stroke'" />
    <div v-if="isMixed" class="panel-empty">多个不同的{{ kind === 'fills' ? '填充' : '描边' }}，添加将统一选中图层。</div>
    <div v-for="(item, index) in items" :key="index" class="paint-item">
      <div class="property-row">
        <span class="field-caption">{{ index + 1 }}</span>
        <button type="button" class="icon-action" :aria-label="item.visible ? '隐藏颜色' : '显示颜色'" @click="actions.toggleVisibility(index)"><component :is="item.visible ? Eye : EyeOff" /></button>
        <button type="button" class="icon-action" aria-label="移除颜色" @click="actions.remove(index)"><Minus /></button>
      </div>
      <PaintEditor :fill="'type' in item ? item : { ...item, type: 'SOLID' }" :solid-only="kind === 'strokes'" @update="actions.patch(index, $event)" />
      <select v-if="binding.colorVariables.value.length" aria-label="绑定颜色变量" :value="boundValue(index)" @change="bind(index, ($event.target as HTMLSelectElement).value)">
        <option value="">不绑定变量</option><option v-if="boundValue(index) === '__mixed__'" value="__mixed__" disabled>混合绑定</option><option v-for="variable in binding.colorVariables.value" :key="variable.id" :value="variable.id">{{ variable.name }}</option>
      </select>
      <div v-if="'weight' in item" class="property-grid">
        <label>宽度<input type="number" min="0" step="0.5" :value="item.weight" @change="actions.patch(index, { weight: Math.max(0, Number(($event.target as HTMLInputElement).value)) })"></label>
        <label>位置<select :value="item.align" @change="actions.patch(index, { align: ($event.target as HTMLSelectElement).value as 'INSIDE' | 'CENTER' | 'OUTSIDE' })"><option value="INSIDE">内部</option><option value="CENTER">居中</option><option value="OUTSIDE">外部</option></select></label>
      </div>
    </div>
  </section>
</template>
