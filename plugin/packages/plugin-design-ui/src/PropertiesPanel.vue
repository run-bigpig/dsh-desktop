<script setup lang="ts">
import { computed, ref } from 'vue'
import { fontManager } from '@open-pencil/core/text'
import type { SceneNode } from '@open-pencil/scene-graph'
import {
  MIXED, useEditor, useNodeProps, usePosition, useAppearance, useLayout,
  useTypography, useEditorPropertyList, useEffectsControls, useExport, useConstraints, useComponentProperties
} from '@open-pencil/vue'
import Plus from '~icons/lucide/plus'
import Minus from '~icons/lucide/minus'
import Eye from '~icons/lucide/eye'
import EyeOff from '~icons/lucide/eye-off'
import AlignLeft from '~icons/lucide/align-start-vertical'
import AlignCenter from '~icons/lucide/align-center-vertical'
import AlignRight from '~icons/lucide/align-end-vertical'
import AlignTop from '~icons/lucide/align-start-horizontal'
import AlignMiddle from '~icons/lucide/align-center-horizontal'
import AlignBottom from '~icons/lucide/align-end-horizontal'
import Bold from '~icons/lucide/bold'
import Italic from '~icons/lucide/italic'
import Underline from '~icons/lucide/underline'
import Strikethrough from '~icons/lucide/strikethrough'
import Download from '~icons/lucide/download'
import PaintList from './PaintList.vue'
import SharedStyleSelect from './SharedStyleSelect.vue'
import { documentIO } from './session-document.ts'
import { finishVectorEdit } from './vector-edit/adapter.ts'

const editor = useEditor()
const { activeNode: node, nodes, merged, updateAllWithUndo } = useNodeProps()
const position = usePosition()
const constraints = useConstraints()
const componentProps = useComponentProperties()
const { hasCornerRadius } = useAppearance()
const layout = useLayout()
const typography = useTypography({ fontLoader: { load: (family, style) => fontManager.loadFont(family, style) } })
const effects = useEditorPropertyList('effects')
const effectControls = useEffectsControls()
const exports = useExport()
const exportFormat = ref('png')
const exportFormats = computed(() => documentIO.listExportFormats(nodes.value.length ? 'selection' : 'page'))
const exportScale = ref(1)
const busy = ref(false)
const error = ref('')
const canLayout = computed(() => nodes.value.length === 1 && ['FRAME', 'COMPONENT', 'INSTANCE'].includes(node.value?.type ?? ''))
const fields = [ ['x', 'X'], ['y', 'Y'], ['width', '宽'], ['height', '高'], ['rotation', '角度'] ] as const
const alignments = [
  { axis: 'horizontal', pos: 'min', label: '左对齐', icon: AlignLeft },
  { axis: 'horizontal', pos: 'center', label: '水平居中', icon: AlignCenter },
  { axis: 'horizontal', pos: 'max', label: '右对齐', icon: AlignRight },
  { axis: 'vertical', pos: 'min', label: '顶对齐', icon: AlignTop },
  { axis: 'vertical', pos: 'center', label: '垂直居中', icon: AlignMiddle },
  { axis: 'vertical', pos: 'max', label: '底对齐', icon: AlignBottom }
] as const
function value(key: keyof SceneNode): string | number {
  const result = merged(key)
  return result === MIXED || result === null ? '' : typeof result === 'number' ? Math.round(result * 100) / 100 : String(result)
}
function patch(changes: Partial<SceneNode>): void {
  editor.undo.runBatch('Update properties', () => updateAllWithUndo(changes, 'Update properties'))
}
function number(key: keyof SceneNode, event: Event, min = -Infinity, max = Infinity, scale = 1): void {
  const input = event.target as HTMLInputElement
  if (!input.value.trim() || !Number.isFinite(input.valueAsNumber)) return
  patch({ [key]: Math.min(max, Math.max(min, input.valueAsNumber)) / scale })
}
async function font(action: Promise<unknown>): Promise<void> {
  try { await action; error.value = '' } catch (reason) { error.value = String(reason) }
}
async function exportImage(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const renderer = editor.renderer
    if (!renderer) throw new Error('画布尚未准备好')
    const ids = [...editor.state.selectedIds]
    const output = await documentIO.exportContent(exportFormat.value, {
      graph: editor.graph,
      target: ids.length ? { scope: 'selection', nodeIds: ids } : { scope: 'page', pageId: editor.state.currentPageId }
    }, { scale: exportScale.value }, { renderer, canvasKit: renderer.ck })
    const data = typeof output.data === 'string' ? output.data : new Uint8Array(output.data)
    const url = URL.createObjectURL(new Blob([data], { type: output.mimeType }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${exports.activeName.value.replace(/[\\/:*?"<>|]/gu, '_')}.${output.extension}`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (reason) { error.value = String(reason) } finally { busy.value = false }
}
</script>

<template>
  <aside class="side-panel properties-panel" aria-label="属性" @focusin="finishVectorEdit(editor)">
    <header class="panel-header"><span>设计</span><span v-if="nodes.length > 1">{{ nodes.length }} 个图层</span></header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <template v-if="node">
      <section v-if="constraints.active.value" class="property-section property-list">
        <header class="section-title">约束</header>
        <label v-for="axis in (['horizontal', 'vertical'] as const)" :key="axis">{{ axis === 'horizontal' ? '水平' : '垂直' }}<select :value="constraints[axis].value === MIXED ? '' : constraints[axis].value" @change="constraints.setAxis(axis, ($event.target as HTMLSelectElement).value as SceneNode['horizontalConstraint'])"><option value="" disabled>混合</option><option value="MIN">起始</option><option value="CENTER">居中</option><option value="MAX">末端</option><option value="STRETCH">拉伸</option><option value="SCALE">缩放</option></select></label>
      </section>
      <section v-if="componentProps.active.value" class="property-section property-list">
        <header class="section-title">组件属性</header>
        <label v-for="control in componentProps.controls.value" :key="control.id">{{ control.name }}
          <select v-if="control.options.length" :value="control.value === MIXED ? '' : control.value" @change="componentProps.setValue(control.id, ($event.target as HTMLSelectElement).value)"><option v-for="option in control.options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
          <input v-else :value="control.value === MIXED ? '' : control.value" placeholder="混合" @change="componentProps.setValue(control.id, ($event.target as HTMLInputElement).value)">
        </label>
      </section>
      <section class="property-section property-list">
        <label v-if="nodes.length === 1">名称<input :value="node.name" @change="editor.renameNode(node.id, ($event.target as HTMLInputElement).value)"></label>
        <div class="alignment-row" role="toolbar" aria-label="对齐">
          <button v-for="item in alignments" :key="item.label" type="button" class="icon-action" :aria-label="item.label" :title="item.label" @click="position.align(item.axis, item.pos)"><component :is="item.icon" /></button>
        </div>
        <div class="property-grid">
          <label v-for="[key, label] in fields" :key="key">{{ label }}<input type="number" :aria-label="label" :value="value(key)" :placeholder="nodes.length > 1 ? '混合' : ''" :min="key === 'width' || key === 'height' ? 0 : undefined" @change="number(key, $event, key === 'width' || key === 'height' ? 0 : -Infinity)"></label>
        </div>
      </section>
      <section class="property-section property-list">
        <header class="section-title">外观</header>
        <label>不透明度<input type="number" min="0" max="100" :value="merged('opacity') === MIXED ? '' : Math.round(Number(merged('opacity')) * 100)" placeholder="混合" @change="number('opacity', $event, 0, 100, 100)"></label>
        <label v-if="hasCornerRadius">圆角<input type="number" min="0" :value="value('cornerRadius')" @change="number('cornerRadius', $event, 0)"></label>
        <label v-if="canLayout" class="checkbox-label"><input type="checkbox" :checked="node.clipsContent" @change="patch({ clipsContent: ($event.target as HTMLInputElement).checked })">裁剪内容</label>
      </section>
      <section v-if="canLayout" class="property-section property-list">
        <header class="section-title">自动布局</header>
        <label>方向<select :value="node.layoutMode" @change="editor.setLayoutMode(node.id, ($event.target as HTMLSelectElement).value as SceneNode['layoutMode'])"><option value="NONE">无</option><option value="HORIZONTAL">水平</option><option value="VERTICAL">垂直</option><option value="GRID">网格</option></select></label>
        <template v-if="node.layoutMode !== 'NONE'">
          <div class="property-grid">
            <label>间距<input type="number" min="0" :value="node.itemSpacing" @change="number('itemSpacing', $event, 0)"></label>
            <label v-for="[key, label] in ([['paddingTop', '上'], ['paddingRight', '右'], ['paddingBottom', '下'], ['paddingLeft', '左']] as const)" :key="key">{{ label }}<input type="number" min="0" :value="node[key]" @change="number(key, $event, 0)"></label>
          </div>
          <label>宽度<select :value="layout.widthSizing.value" @change="layout.setAxisSizing('width', ($event.target as HTMLSelectElement).value as 'FIXED' | 'HUG' | 'FILL')"><option v-for="option in layout.widthSizingOptions.value" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label>高度<select :value="layout.heightSizing.value" @change="layout.setAxisSizing('height', ($event.target as HTMLSelectElement).value as 'FIXED' | 'HUG' | 'FILL')"><option v-for="option in layout.heightSizingOptions.value" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <div class="alignment-grid" role="group" aria-label="布局对齐"><button v-for="(cell, i) in layout.alignGrid.value" :key="i" type="button" :aria-label="`布局对齐 ${i + 1}`" :aria-pressed="node.primaryAxisAlign === cell.primary && node.counterAxisAlign === cell.counter" @click="layout.setAlignment(cell.primary, cell.counter)"><span /></button></div>
          <template v-if="node.layoutMode === 'GRID'">
            <div v-for="prop in (['gridTemplateColumns', 'gridTemplateRows'] as const)" :key="prop">
              <div class="property-row"><span>{{ prop === 'gridTemplateColumns' ? '列' : '行' }}</span><button class="icon-action" type="button" aria-label="添加网格轨道" @click="layout.addTrack(prop)"><Plus /></button></div>
              <div v-for="(track, i) in node[prop]" :key="i" class="property-row"><span>{{ layout.trackLabel(track) }}</span><button type="button" class="icon-action" aria-label="移除网格轨道" :disabled="node[prop].length <= 1" @click="layout.removeTrack(prop, i)"><Minus /></button></div>
            </div>
          </template>
        </template>
      </section>
      <section v-if="node.type === 'TEXT' && nodes.length === 1" class="property-section property-list">
        <header class="section-title">文字</header>
        <SharedStyleSelect kind="text" />
        <label>字体<input :value="typography.fontFamily.value" @change="font(typography.setFamily(($event.target as HTMLInputElement).value))"></label>
        <label>字重<select :value="typography.fontWeight.value" @change="font(typography.setWeight(Number(($event.target as HTMLSelectElement).value)))"><option v-for="weight in typography.weights" :key="weight.value" :value="weight.value">{{ weight.label }}</option></select></label>
        <div class="property-grid"><label>字号<input type="number" min="1" :value="node.fontSize" @change="number('fontSize', $event, 1)"></label><label>字距<input type="number" :value="node.letterSpacing" @change="number('letterSpacing', $event)"></label><label>行高<input type="number" min="0" :value="node.lineHeight" placeholder="自动" @change="number('lineHeight', $event, 0)"></label></div>
        <div class="alignment-row" role="toolbar" aria-label="文字格式">
          <button type="button" class="icon-action" aria-label="粗体" :aria-pressed="typography.activeFormatting.value.includes('bold')" @click="typography.toggleBold()"><Bold /></button>
          <button type="button" class="icon-action" aria-label="斜体" :aria-pressed="typography.activeFormatting.value.includes('italic')" @click="typography.toggleItalic()"><Italic /></button>
          <button type="button" class="icon-action" aria-label="下划线" :aria-pressed="typography.activeFormatting.value.includes('underline')" @click="typography.toggleDecoration('UNDERLINE')"><Underline /></button>
          <button type="button" class="icon-action" aria-label="删除线" :aria-pressed="typography.activeFormatting.value.includes('strikethrough')" @click="typography.toggleDecoration('STRIKETHROUGH')"><Strikethrough /></button>
        </div>
        <label>对齐<select :value="node.textAlignHorizontal" @change="typography.setAlign(($event.target as HTMLSelectElement).value as SceneNode['textAlignHorizontal'])"><option value="LEFT">左对齐</option><option value="CENTER">居中</option><option value="RIGHT">右对齐</option><option value="JUSTIFIED">两端对齐</option></select></label>
        <div v-if="typography.hasMissingFonts.value" class="panel-empty">文档使用的部分字体不可用，请选择已安装的字体。</div>
      </section>
      <PaintList kind="fills" /><PaintList kind="strokes" />
      <section class="property-section" @focusout="effects.flush">
        <header class="panel-header"><span>效果</span><button type="button" class="icon-action" aria-label="添加效果" @click="effects.actions.add(effectControls.createDefaultEffect())"><Plus /></button></header>
        <SharedStyleSelect kind="effect" />
        <div v-if="effects.isMixed.value" class="panel-empty">多个不同效果</div>
        <div v-for="(effect, index) in effects.items.value" :key="index" class="property-list">
          <div class="property-row"><select aria-label="效果类型" :value="effect.type" @change="effectControls.updateType(effects.actions.patch, node, index, ($event.target as HTMLSelectElement).value as typeof effect.type)"><option v-for="option in effectControls.effectOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select><button type="button" class="icon-action" aria-label="切换效果显示" @click="effects.actions.toggleVisibility(index)"><component :is="effect.visible ? Eye : EyeOff" /></button><button type="button" class="icon-action" aria-label="移除效果" @click="effects.actions.remove(index)"><Minus /></button></div>
          <div class="property-grid"><label>模糊<input type="number" min="0" :value="effect.radius" @change="effects.actions.patch(index, { radius: Math.max(0, Number(($event.target as HTMLInputElement).value)) })"></label><label v-if="effectControls.isShadow(effect.type)">扩展<input type="number" :value="effect.spread" @change="effects.actions.patch(index, { spread: Number(($event.target as HTMLInputElement).value) })"></label></div>
          <div v-if="effectControls.isShadow(effect.type)" class="property-grid"><label v-for="axis in (['x', 'y'] as const)" :key="axis">{{ axis.toUpperCase() }}<input type="number" :value="effect.offset[axis]" @change="effects.actions.patch(index, { offset: { ...effect.offset, [axis]: Number(($event.target as HTMLInputElement).value) } })"></label></div>
        </div>
      </section>
    </template>
    <div v-else class="panel-empty">选择图层以编辑其属性</div>
    <section class="property-section property-list">
      <header class="section-title">导出{{ nodes.length ? '选中图层' : '页面' }}</header>
      <div class="property-row"><select v-model="exportFormat" aria-label="导出格式"><option v-for="format in exportFormats" :key="format.id" :value="format.id">{{ format.label }}</option></select><select v-model="exportScale" aria-label="导出倍率" :disabled="!documentIO.getFormat(exportFormat)?.exportOptions?.scale"><option v-for="scale in exports.scales" :key="scale" :value="scale">{{ scale }}×</option></select></div>
      <button type="button" :disabled="busy" @click="exportImage"><Download />{{ busy ? '正在导出…' : '导出' }}</button>
    </section>
  </aside>
</template>
