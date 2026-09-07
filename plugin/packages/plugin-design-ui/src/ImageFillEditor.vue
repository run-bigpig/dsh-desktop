<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { useEditor } from '@open-pencil/vue'
import type { Fill, ImageScaleMode } from '@open-pencil/scene-graph'
import ImageIcon from '~icons/lucide/image'

const props = defineProps<{ fill: Fill }>()
const emit = defineEmits<{ update: [patch: Partial<Fill>] }>()
const editor = useEditor()
const fileInput = ref<HTMLInputElement | null>(null)
const preview = ref('')
const busy = ref(false)
const error = ref('')
let disposed = false
watch(() => props.fill.imageHash, hash => {
  if (preview.value) URL.revokeObjectURL(preview.value)
  const bytes = hash ? editor.getImage(hash) : undefined
  preview.value = bytes ? URL.createObjectURL(new Blob([new Uint8Array(bytes)])) : ''
}, { immediate: true })
onUnmounted(() => { disposed = true; if (preview.value) URL.revokeObjectURL(preview.value) })

async function choose(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const selection = [...editor.state.selectedIds].join(',')
  const originalFill = props.fill
  busy.value = true
  error.value = ''
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片')
    const bitmap = await createImageBitmap(file)
    bitmap.close()
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (disposed || props.fill !== originalFill || selection !== [...editor.state.selectedIds].join(',')) return
    emit('update', { type: 'IMAGE', imageHash: editor.storeImage(bytes), imageScaleMode: props.fill.imageScaleMode ?? 'FILL' })
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
</script>

<template>
  <div class="image-fill-editor">
    <img v-if="preview" :src="preview" alt="填充图片预览" class="image-fill-preview">
    <div v-else class="panel-empty">选择图片作为当前图层的填充</div>
    <input ref="fileInput" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" aria-label="填充图片文件" @change="choose">
    <button type="button" class="compact-action" :disabled="busy" @click="fileInput?.click()"><ImageIcon />{{ busy ? '正在加载…' : fill.imageHash ? '替换图片' : '选择图片' }}</button>
    <label class="property-row">缩放<select aria-label="图片缩放模式" :value="fill.imageScaleMode ?? 'FILL'" @change="emit('update', { imageScaleMode: ($event.target as HTMLSelectElement).value as ImageScaleMode })"><option value="FILL">填充</option><option value="FIT">适应</option><option value="CROP">裁剪</option><option value="TILE">平铺</option></select></label>
    <div v-if="error" role="alert" class="error-banner">{{ error }}</div>
  </div>
</template>
