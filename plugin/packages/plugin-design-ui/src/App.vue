<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import EditorWorkspace from './EditorWorkspace.vue'
import {
  createBlankDocument,
  isDirty,
  openDocument,
  saveDocument,
  type DesignSession,
  type WritableFileHandle
} from './runtime.ts'

const props = defineProps<{ session: DesignSession }>()
const fileInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const error = ref('')
const dirty = computed(() => {
  void props.session.revision
  return isDirty(props.session)
})

function canReplaceDocument(): boolean {
  return !dirty.value || window.confirm('当前设计尚未另存为 .fig 文件。替换文档也会更新此会话的设计快照，确定继续吗？')
}

function createDocument(): void {
  if (!canReplaceDocument()) return
  error.value = ''
  createBlankDocument(props.session)
}

async function chooseFile(): Promise<void> {
  if (!canReplaceDocument()) return
  error.value = ''
  if (typeof window.showOpenFilePicker !== 'function') {
    fileInput.value?.click()
    return
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{
        description: 'StarWeave 设计文档',
        accept: { 'application/octet-stream': ['.fig'], 'application/json': ['.pen'] }
      }]
    })
    if (handle) await loadFile(await handle.getFile(), handle)
  } catch (reason) {
    if (!(reason instanceof DOMException && reason.name === 'AbortError')) showError(reason)
  }
}

async function onFileInput(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) await loadFile(file)
}

async function loadFile(file: File, handle?: WritableFileHandle): Promise<void> {
  busy.value = true
  try { await openDocument(props.session, file, handle) } catch (reason) { showError(reason) } finally { busy.value = false }
}

async function save(): Promise<void> {
  busy.value = true
  error.value = ''
  try { await saveDocument(props.session) } catch (reason) { showError(reason) } finally { busy.value = false }
}

function showError(reason: unknown): void {
  error.value = reason instanceof Error ? reason.message : String(reason)
}

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => window.addEventListener('beforeunload', warnBeforeUnload))
onUnmounted(() => window.removeEventListener('beforeunload', warnBeforeUnload))
</script>

<template>
  <main class="design-root">
    <header class="document-bar">
      <div class="document-actions">
        <button type="button" :disabled="busy" @click="createDocument">新建设计</button>
        <button type="button" :disabled="busy" @click="chooseFile">打开文件</button>
        <button type="button" :disabled="busy || !session.document" @click="save">保存</button>
        <input ref="fileInput" class="visually-hidden" type="file" accept=".fig,.pen,application/json" @change="onFileInput">
      </div>
      <div class="document-state" role="status" aria-live="polite">
        <strong>{{ session.document?.name ?? '尚未打开文档' }}</strong>
        <span v-if="session.document" :class="dirty ? 'unsaved' : 'saved'" title="会话快照自动保存；保存按钮用于另存为 .fig 文件">{{ dirty ? '未另存为文件' : '文件已保存' }}</span>
        <span class="bridge-state" :data-phase="session.bridgePhase">{{ session.bridgeDetail }}</span>
      </div>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div v-if="session.persistenceError" class="error-banner" role="alert">{{ session.persistenceError }}</div>
    <EditorWorkspace
      v-if="session.document"
      :key="session.generation"
      :editor="session.document.editor"
      :revision="session.revision"
    />
    <section v-else class="empty-state">
      <div class="empty-card">
        <h1>开始设计</h1>
        <p>新建空白设计或打开本地 .fig / .pen 文件。完成后 Agent 才会连接，并且只操作当前文档。</p>
        <div class="empty-actions">
          <button type="button" class="primary" :disabled="busy" @click="createDocument">新建设计</button>
          <button type="button" :disabled="busy" @click="chooseFile">打开文件</button>
        </div>
      </div>
    </section>
  </main>
</template>
