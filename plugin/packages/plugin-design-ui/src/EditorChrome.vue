<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { LayerTreeRoot, useEditor, useEditorCommands, usePageList, type EditorCommandId } from '@open-pencil/vue'
import Plus from '~icons/lucide/plus'
import Pencil from '~icons/lucide/pencil'
import Trash from '~icons/lucide/trash-2'
import Undo from '~icons/lucide/undo-2'
import Redo from '~icons/lucide/redo-2'
import Menu from '~icons/lucide/menu'
import PanelLeft from '~icons/lucide/panel-left'
import PanelRight from '~icons/lucide/panel-right'
import ZoomIn from '~icons/lucide/zoom-in'
import ZoomOut from '~icons/lucide/zoom-out'
import CanvasWorkspace from './CanvasWorkspace.vue'
import DesignToolbar from './DesignToolbar.vue'
import LayerRow from './LayerRow.vue'
import PropertiesPanel from './PropertiesPanel.vue'
import VariablesDialog from './VariablesDialog.vue'
import VectorEditBar from './VectorEditBar.vue'
import { finishVectorEdit } from './vector-edit/adapter.ts'
import { createEditorInput } from './editor-input.ts'

defineProps<{ revision: number }>()
const editor = useEditor()
const commands = useEditorCommands()
const { pages, currentPageId, addPage, switchPage, deletePage, renamePage } = usePageList()
const workspace = ref<HTMLElement | null>(null)
const width = ref(900)
const layersPreference = ref<boolean>()
const propertiesPreference = ref<boolean>()
const showLayers = computed(() => layersPreference.value ?? width.value > 740)
const showProperties = computed(() => propertiesPreference.value ?? width.value > 650)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(entries => { width.value = entries[0].contentRect.width })
  if (workspace.value) observer.observe(workspace.value)
})
onUnmounted(() => observer?.disconnect())
const error = ref('')
const menu = ref<HTMLDetailsElement | null>(null)
const { keydown, keyup, clipboard } = createEditorInput(editor, commands, reason => { error.value = String(reason) })
const commandGroups: Array<{ label: string; ids: EditorCommandId[] }> = [
  { label: '编辑', ids: ['edit.undo', 'edit.redo', 'selection.selectAll', 'selection.selectInverse', 'selection.duplicate', 'selection.delete'] },
  { label: '组织图层', ids: ['selection.group', 'selection.frameSelection', 'selection.ungroup', 'selection.wrapInAutoLayout', 'selection.toggleMask', 'selection.toggleVisibility', 'selection.toggleLock'] },
  { label: '排列', ids: ['selection.bringForward', 'selection.bringToFront', 'selection.sendBackward', 'selection.sendToBack', 'selection.flipHorizontal', 'selection.flipVertical', 'selection.distributeHorizontal', 'selection.distributeVertical'] },
  { label: '组件', ids: ['selection.createComponent', 'selection.createComponentSet', 'selection.createInstance', 'selection.detachInstance', 'selection.goToMainComponent'] },
  { label: '路径', ids: ['selection.booleanUnion', 'selection.booleanSubtract', 'selection.booleanIntersect', 'selection.booleanExclude', 'selection.flatten', 'selection.outlineText', 'selection.outlineStroke'] },
  { label: '视图', ids: ['view.zoom100', 'view.zoomFit', 'view.zoomSelection'] }
]
function run(id: EditorCommandId): void {
  error.value = ''
  try { editor.flushNudge(); finishVectorEdit(editor); commands.runCommand(id) } catch (reason) { error.value = String(reason) }
  if (menu.value) menu.value.open = false
}
function zoom(factor: number): void {
  const renderer = editor.renderer
  if (renderer) editor.setZoomAroundPoint(editor.state.zoom * factor, renderer.viewportWidth / 2, renderer.viewportHeight / 2)
}
function rename(id: string, name: string): void {
  const next = window.prompt('页面名称', name)?.trim()
  if (next) renamePage(id, next)
}
function removePage(id: string): void {
  if (pages.value.length > 1 && window.confirm('删除此页面及其中的所有图层？')) deletePage(id)
}
function contextMenu(event: MouseEvent): void {
  if ((event.target as HTMLElement).closest('input, textarea, select')) return
  event.preventDefault()
  if (menu.value) { menu.value.open = true; menu.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
}
function closeMenus(event: MouseEvent): void {
  if (!(event.target as HTMLElement).closest('details') && menu.value) menu.value.open = false
}
</script>

<template>
  <section ref="workspace" class="editor-workspace" tabindex="-1" @keydown="keydown" @keyup="keyup" @focusout="editor.flushNudge()" @copy="clipboard" @cut="clipboard" @paste="clipboard" @click="closeMenus" @contextmenu="contextMenu">
    <div class="editor-commandbar" role="toolbar" aria-label="编辑与视图">
      <details ref="menu" class="command-menu" @keydown.esc.prevent="menu && (menu.open = false)">
        <summary aria-label="编辑菜单" title="编辑菜单"><Menu /></summary>
        <div class="command-list">
          <section v-for="group in commandGroups" :key="group.label">
            <div class="menu-label">{{ group.label }}</div>
            <button v-for="id in group.ids" :key="id" type="button" :disabled="commands.menuItem(id).disabled" @click="run(id)">
              <span>{{ commands.menuItem(id).label }}</span><kbd>{{ commands.menuItem(id).shortcut }}</kbd>
            </button>
          </section>
          <section v-if="editor.state.selectedIds.size">
            <div class="menu-label">移动到页面</div>
            <button v-for="page in commands.otherPages.value" :key="page.id" type="button" @click="commands.moveSelectionToPage(page.id); menu && (menu.open = false)">{{ page.name }}</button>
          </section>
        </div>
      </details>
      <button type="button" class="icon-action" aria-label="撤销" title="撤销 (Ctrl+Z)" :disabled="commands.menuItem('edit.undo').disabled" @click="run('edit.undo')"><Undo /></button>
      <button type="button" class="icon-action" aria-label="重做" title="重做 (Ctrl+Shift+Z)" :disabled="commands.menuItem('edit.redo').disabled" @click="run('edit.redo')"><Redo /></button>
      <VariablesDialog />
      <span class="toolbar-spacer" />
      <button type="button" class="icon-action" aria-label="缩小" title="缩小" @click="zoom(0.8)"><ZoomOut /></button>
      <button type="button" class="zoom-value" title="恢复 100%" @click="run('view.zoom100')">{{ Math.round(editor.state.zoom * 100) }}%</button>
      <button type="button" class="icon-action" aria-label="放大" title="放大" @click="zoom(1.25)"><ZoomIn /></button>
      <button type="button" class="compact-action" title="缩放到全部内容 (Shift+1)" @click="run('view.zoomFit')">适合画布</button>
      <button type="button" class="icon-action" aria-label="切换图层面板" title="图层面板" :aria-pressed="showLayers" @click="layersPreference = !showLayers"><PanelLeft /></button>
      <button type="button" class="icon-action" aria-label="切换属性面板" title="属性面板" :aria-pressed="showProperties" @click="propertiesPreference = !showProperties"><PanelRight /></button>
    </div>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div class="editor-shell">
      <aside v-if="showLayers" class="side-panel layers-panel" aria-label="页面和图层">
        <section class="pages-section">
          <header class="panel-header"><span>页面</span><button type="button" class="icon-action" title="新建页面" aria-label="新建页面" @click="addPage()"><Plus /></button></header>
          <nav class="page-list" aria-label="页面">
            <div v-for="page in pages" :key="page.id" class="page-entry">
              <button type="button" class="page-row" :class="{ selected: page.id === currentPageId }" @click="switchPage(page.id)" @dblclick="rename(page.id, page.name)"><span>{{ page.name }}</span></button>
              <button type="button" class="icon-action page-action" title="重命名页面" aria-label="重命名页面" @click="rename(page.id, page.name)"><Pencil /></button>
              <button type="button" class="icon-action page-action" title="删除页面" aria-label="删除页面" :disabled="pages.length <= 1" @click="removePage(page.id)"><Trash /></button>
            </div>
          </nav>
        </section>
        <LayerTreeRoot v-slot="{ visibleRows, expanded }" :indent-per-level="14" class="layer-tree-root">
          <section class="layers-section">
            <header class="panel-header"><span>图层</span></header>
            <div v-if="!visibleRows.length" class="panel-empty">当前页面为空</div>
            <div v-else class="layer-list" role="tree" aria-label="图层" aria-multiselectable="true">
              <LayerRow v-for="row in visibleRows" :key="row.node.id" :row="row" :expanded="expanded.includes(row.node.id)" />
            </div>
          </section>
        </LayerTreeRoot>
      </aside>
      <div class="canvas-stage"><CanvasWorkspace :revision="revision" /><DesignToolbar /><VectorEditBar :revision="revision" /></div>
      <PropertiesPanel v-if="showProperties" />
    </div>
  </section>
</template>
