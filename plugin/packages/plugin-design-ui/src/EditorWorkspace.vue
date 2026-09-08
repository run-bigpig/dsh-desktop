<script setup lang="ts">
import type { Editor } from '@open-pencil/core/editor'
import { provideEditor } from '@open-pencil/vue'
import EditorChrome from './EditorChrome.vue'

const props = defineProps<{ editor: Editor; revision: number }>()
provideEditor(props.editor)
</script>

<template><EditorChrome :revision="revision" /></template>
