<script setup lang="ts">
import { ref } from 'vue'
import { useVariables } from '@open-pencil/vue'
import type { Variable, VariableType } from '@open-pencil/scene-graph'
import Plus from '~icons/lucide/plus'
import Trash from '~icons/lucide/trash-2'
import X from '~icons/lucide/x'
import SlidersHorizontal from '~icons/lucide/sliders-horizontal'

const dialog = ref<HTMLDialogElement | null>(null)
const variables = useVariables()
const type = ref<VariableType>('COLOR')
const error = ref('')
function change(variable: Variable, modeId: string, raw: string): void {
  const value = variables.parseVariableValue(variable, raw)
  if (value === undefined) { error.value = '请输入有效的变量值'; return }
  variables.updateVariableValue(variable.id, modeId, value)
  error.value = ''
}
function removeCollection(): void {
  if (window.confirm('删除此变量集合及所有变量？')) variables.removeCollection(variables.activeCollectionId.value)
}
</script>

<template>
  <button type="button" class="icon-action" aria-label="本地变量" title="本地变量" @click="dialog?.showModal()"><SlidersHorizontal /></button>
  <dialog ref="dialog" class="variables-dialog" @keydown.stop @copy.stop @cut.stop @paste.stop>
    <header class="panel-header"><span>本地变量</span><button type="button" class="icon-action" aria-label="关闭变量" @click="dialog?.close()"><X /></button></header>
    <div class="variables-body">
      <div class="property-row">
        <select aria-label="变量集合" :value="variables.activeCollectionId.value" @change="variables.setActiveCollection(($event.target as HTMLSelectElement).value)"><option v-for="collection in variables.collections.value" :key="collection.id" :value="collection.id">{{ collection.name }}</option></select>
        <button type="button" class="compact-action" @click="variables.addCollection"><Plus />新建集合</button>
        <button type="button" class="icon-action" aria-label="删除变量集合" :disabled="!variables.activeCollection.value" @click="removeCollection"><Trash /></button>
      </div>
      <template v-if="variables.activeCollection.value">
        <label class="property-row">集合名称<input :value="variables.activeCollection.value.name" @change="variables.renameCollection(variables.activeCollectionId.value, ($event.target as HTMLInputElement).value)"></label>
        <div class="property-row"><input aria-label="搜索变量" placeholder="搜索变量" :value="variables.searchTerm.value" @input="variables.setSearchTerm(($event.target as HTMLInputElement).value)"><select v-model="type" aria-label="变量类型"><option value="COLOR">颜色</option><option value="FLOAT">数值</option><option value="STRING">文本</option><option value="BOOLEAN">布尔值</option></select><button type="button" class="compact-action" @click="variables.addVariable(type)"><Plus />添加变量</button><button type="button" class="compact-action" @click="variables.addMode"><Plus />添加模式</button></div>
        <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
        <div class="variables-table-wrap"><table class="variables-table">
          <thead><tr><th>名称</th><th v-for="mode in variables.activeModes.value" :key="mode.modeId">
            <input aria-label="模式名称" :value="mode.name" @change="variables.renameMode(mode.modeId, ($event.target as HTMLInputElement).value)">
            <button type="button" class="compact-action" :aria-pressed="variables.activeCollection.value.defaultModeId === mode.modeId" @click="variables.setDefaultMode(mode.modeId); variables.setActiveMode(mode.modeId)">设为默认</button>
            <button type="button" class="icon-action" aria-label="删除变量模式" :disabled="variables.activeModes.value.length <= 1" @click="variables.removeMode(mode.modeId)"><Trash /></button>
          </th><th /></tr></thead>
          <tbody><tr v-for="variable in variables.variables.value" :key="variable.id">
            <td><input aria-label="变量名称" :value="variable.name" @change="variables.renameVariable(variable.id, ($event.target as HTMLInputElement).value)"></td>
            <td v-for="mode in variables.activeModes.value" :key="mode.modeId"><input :aria-label="`${variable.name} ${mode.name}`" :value="variables.formatModeValue(variable, mode.modeId)" @change="change(variable, mode.modeId, ($event.target as HTMLInputElement).value)"></td>
            <td><button type="button" class="icon-action" aria-label="删除变量" @click="variables.removeVariable(variable.id)"><Trash /></button></td>
          </tr></tbody>
        </table></div>
        <div v-if="!variables.variables.value.length" class="panel-empty">此集合暂无变量</div>
      </template>
      <div v-else class="panel-empty">创建集合以管理可复用的颜色、数值和文本。</div>
    </div>
  </dialog>
</template>
