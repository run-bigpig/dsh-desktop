<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Editor, Tool } from '@open-pencil/core/editor'
import {
  provideEditor,
  ToolbarItem,
  ToolbarRoot,
  useCanvas,
  useCanvasInput,
  useTextEdit
} from '@open-pencil/vue'

const props = defineProps<{ editor: Editor; revision: number }>()
provideEditor(props.editor)
const tools: Array<{ id: Tool; label: string }> = [
  { id: 'SELECT', label: '选择' },
  { id: 'FRAME', label: '画板' },
  { id: 'RECTANGLE', label: '矩形' },
  { id: 'ELLIPSE', label: '椭圆' },
  { id: 'TEXT', label: '文本' },
  { id: 'PEN', label: '钢笔' },
  { id: 'HAND', label: '抓手' }
]

const canvas = ref<HTMLCanvasElement | null>(null)
const { hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle } = useCanvas(canvas, props.editor)
const { cursorOverride } = useCanvasInput(
  canvas,
  props.editor,
  hitTestSectionTitle,
  hitTestComponentLabel,
  hitTestFrameTitle
)
useTextEdit(canvas, props.editor)

const layers = computed(() => {
  void props.revision
  const page = props.editor.graph.getNode(props.editor.state.currentPageId)
  if (!page) return []
  const rows: Array<{ id: string; name: string; type: string; depth: number }> = []
  const visit = (id: string, depth: number): void => {
    const node = props.editor.graph.getNode(id)
    if (!node) return
    rows.push({ id: node.id, name: node.name, type: node.type, depth })
    for (const child of node.childIds) visit(child, depth + 1)
  }
  for (const id of page.childIds) visit(id, 0)
  return rows
})
const selected = computed(() => {
  void props.revision
  const id = [...props.editor.state.selectedIds][0]
  return id ? props.editor.graph.getNode(id) ?? null : null
})

function updateSelected(key: 'name' | 'x' | 'y' | 'width' | 'height', value: string): void {
  const node = selected.value
  if (!node) return
  const next = key === 'name' ? value : Number(value)
  if (key !== 'name' && !Number.isFinite(next)) return
  props.editor.updateNode(node.id, { [key]: next })
}
</script>

<template>
  <section class="editor-shell">
      <ToolbarRoot>
        <div class="tool-row" role="toolbar" aria-label="设计工具">
          <ToolbarItem v-for="tool in tools" :key="tool.id" v-slot="{ active, actions }" :tool="tool.id">
            <button type="button" class="tool-button" :class="{ active }" :aria-pressed="active" @click="actions.select">
              {{ tool.label }}
            </button>
          </ToolbarItem>
        </div>
      </ToolbarRoot>
      <div class="workspace-grid">
        <aside class="side-panel layers-panel" aria-label="图层">
          <h2>图层</h2>
          <div v-if="layers.length === 0" class="panel-empty">当前页面为空</div>
          <button
            v-for="layer in layers"
            :key="layer.id"
            type="button"
            class="layer-row"
            :class="{ selected: editor.state.selectedIds.has(layer.id) }"
            :style="{ paddingLeft: `${10 + layer.depth * 14}px` }"
            @click="editor.select([layer.id])"
          >
            <span>{{ layer.name }}</span><small>{{ layer.type }}</small>
          </button>
        </aside>
        <div class="canvas-wrap">
          <canvas ref="canvas" class="design-canvas" tabindex="0" :style="{ cursor: cursorOverride ?? 'default' }" />
        </div>
        <aside class="side-panel properties-panel" aria-label="属性">
          <h2>属性</h2>
          <div v-if="!selected" class="panel-empty">选择一个图层以编辑属性</div>
          <div v-else class="property-list">
            <label>名称<input :value="selected.name" @change="updateSelected('name', ($event.target as HTMLInputElement).value)"></label>
            <label>X<input type="number" :value="selected.x" @change="updateSelected('x', ($event.target as HTMLInputElement).value)"></label>
            <label>Y<input type="number" :value="selected.y" @change="updateSelected('y', ($event.target as HTMLInputElement).value)"></label>
            <label>宽<input type="number" min="0" :value="selected.width" @change="updateSelected('width', ($event.target as HTMLInputElement).value)"></label>
            <label>高<input type="number" min="0" :value="selected.height" @change="updateSelected('height', ($event.target as HTMLInputElement).value)"></label>
          </div>
        </aside>
      </div>
  </section>
</template>
