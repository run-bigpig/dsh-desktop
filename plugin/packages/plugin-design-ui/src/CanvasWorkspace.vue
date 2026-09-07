<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  toolCursor,
  useCanvas,
  useCanvasDrop,
  useCanvasInput,
  useEditor,
  useTextEdit
} from '@open-pencil/vue'
import { flushVectorEdit } from './vector-edit/adapter.ts'

const props = defineProps<{ revision: number }>()
const editor = useEditor()
const canvasRef = ref<HTMLCanvasElement | null>(null)

const { hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle } = useCanvas(
  canvasRef,
  editor,
  { onReady: () => editor.zoomToFit() }
)
const { cursorOverride } = useCanvasInput(
  canvasRef,
  editor,
  hitTestSectionTitle,
  hitTestComponentLabel,
  hitTestFrameTitle
)
const { isDraggingOver } = useCanvasDrop(canvasRef, editor)
const cursor = computed(() => {
  void props.revision
  return toolCursor(editor.state.activeTool, cursorOverride.value)
})

useTextEdit(canvasRef, editor)
function commitVectorGesture(): void { queueMicrotask(() => flushVectorEdit(editor)) }
onMounted(() => window.addEventListener('mouseup', commitVectorGesture))
onUnmounted(() => window.removeEventListener('mouseup', commitVectorGesture))
</script>

<template>
  <div class="canvas-wrap">
    <canvas
      ref="canvasRef"
      class="design-canvas"
      tabindex="-1"
      :style="{ cursor }"
      aria-label="StarWeave 设计画布"
    />
    <div v-if="isDraggingOver" class="canvas-drop" aria-hidden="true" />
  </div>
</template>
