<script setup lang="ts">
import { computed } from 'vue'
import { useFill } from '@open-pencil/vue'
import type { Fill } from '@open-pencil/scene-graph'
import type { Color } from '@open-pencil/scene-graph/primitives'
import Plus from '~icons/lucide/plus'
import Minus from '~icons/lucide/minus'
import ImageFillEditor from './ImageFillEditor.vue'

const props = defineProps<{ fill: Fill; solidOnly?: boolean }>()
const emit = defineEmits<{ update: [patch: Partial<Fill>] }>()
const { category, swatchBackground, toSolid, toGradient, toImage } = useFill(computed(() => props.fill), value => emit('update', value))
function hex(color: Color): string { return '#' + [color.r, color.g, color.b].map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('') }
function color(value: string, alpha: number): Color {
  return { r: parseInt(value.slice(1, 3), 16) / 255, g: parseInt(value.slice(3, 5), 16) / 255, b: parseInt(value.slice(5, 7), 16) / 255, a: alpha }
}
function updateColor(value: string): void {
  if (/^#[0-9a-f]{6}$/iu.test(value)) emit('update', { color: color(value, props.fill.color.a) })
}
function updateStop(index: number, changes: Partial<NonNullable<Fill['gradientStops']>[number]>): void {
  emit('update', { gradientStops: props.fill.gradientStops?.map((stop, i) => i === index ? { ...stop, ...changes } : stop) })
}
function addStop(): void {
  emit('update', { gradientStops: [...(props.fill.gradientStops ?? []), { position: 0.5, color: { ...props.fill.color } }].sort((a, b) => a.position - b.position) })
}
</script>

<template>
  <div class="paint-controls">
    <div class="property-row">
      <span class="paint-swatch" :style="{ background: swatchBackground }" />
      <select aria-label="颜色类型" :value="category" @change="($event.target as HTMLSelectElement).value === 'SOLID' ? toSolid() : ($event.target as HTMLSelectElement).value === 'IMAGE' ? toImage() : toGradient()">
        <option value="SOLID">纯色</option><option v-if="!solidOnly" value="GRADIENT">渐变</option><option v-if="!solidOnly" value="IMAGE">图片</option>
      </select>
      <input class="opacity-field" type="number" min="0" max="100" :value="Math.round(fill.opacity * 100)" aria-label="颜色不透明度" @change="emit('update', { opacity: Math.max(0, Math.min(100, Number(($event.target as HTMLInputElement).value))) / 100 })"><span>%</span>
    </div>
    <div v-if="category === 'SOLID'" class="property-row">
      <input type="color" :value="hex(fill.color)" aria-label="颜色" @change="updateColor(($event.target as HTMLInputElement).value)">
      <input :value="hex(fill.color).toUpperCase()" aria-label="十六进制颜色" pattern="#[0-9A-Fa-f]{6}" @change="updateColor(($event.target as HTMLInputElement).value)">
    </div>
    <template v-else-if="category === 'GRADIENT'">
      <select aria-label="渐变类型" :value="fill.type" @change="emit('update', { type: ($event.target as HTMLSelectElement).value as Fill['type'] })">
        <option value="GRADIENT_LINEAR">线性</option><option value="GRADIENT_RADIAL">径向</option><option value="GRADIENT_ANGULAR">角度</option><option value="GRADIENT_DIAMOND">菱形</option>
      </select>
      <div v-for="(stop, index) in fill.gradientStops" :key="index" class="property-row">
        <input type="color" :value="hex(stop.color)" :aria-label="`渐变色标 ${index + 1}`" @change="updateStop(index, { color: color(($event.target as HTMLInputElement).value, stop.color.a) })">
        <input type="number" min="0" max="100" :value="Math.round(stop.position * 100)" aria-label="色标位置" @change="updateStop(index, { position: Math.max(0, Math.min(100, Number(($event.target as HTMLInputElement).value))) / 100 })"><span>%</span>
        <button type="button" class="icon-action" aria-label="移除色标" :disabled="(fill.gradientStops?.length ?? 0) <= 2" @click="emit('update', { gradientStops: fill.gradientStops?.filter((_, i) => i !== index) })"><Minus /></button>
      </div>
      <button type="button" class="compact-action" @click="addStop"><Plus />添加色标</button>
    </template>
    <ImageFillEditor v-else-if="category === 'IMAGE'" :fill="fill" @update="emit('update', $event)" />
  </div>
</template>
