<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import EditorWorkspace from './EditorWorkspace.vue'
import {
  createBlankDocument,
  isDirty,
  openDocument,
  saveDocument,
  saveState,
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

const saveStatus = computed(() => {
  void props.session.revision
  return saveState(props.session)
})
const saveLabels = { saved: '已保存', unsaved: '未保存', saving: '正在保存…', error: '保存失败' }

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
        <button v-if="!session.binding" type="button" :disabled="busy || session.bridgePhase === 'standby'" @click="createDocument">新建设计</button>
        <button v-if="!session.binding" type="button" :disabled="busy || session.bridgePhase === 'standby'" @click="chooseFile">打开文件</button>
        <button type="button" :disabled="busy || !session.document || session.bridgePhase === 'standby'" @click="save">保存</button>
        <input ref="fileInput" class="visually-hidden" type="file" accept=".fig,.pen,application/json" @change="onFileInput">
      </div>
      <div class="document-state" role="status" aria-live="polite">
        <strong>{{ session.document?.name ?? '尚未打开文档' }}</strong>
        <span v-if="session.document && session.bridgePhase === 'connected'" :class="saveStatus === 'saved' ? 'saved' : 'unsaved'" :data-save-state="saveStatus" :title="session.binding?.path ?? '会话快照自动保存'">{{ saveLabels[saveStatus] }}</span>
        <span class="bridge-state" :data-phase="session.bridgePhase" role="img" :aria-label="session.bridgeDetail" :title="session.bridgeDetail" />
      </div>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div v-if="session.persistenceError" class="error-banner" role="alert">{{ session.persistenceError }}</div>
    <EditorWorkspace
      v-if="session.document && session.bridgePhase !== 'standby'"
      :key="session.generation"
      :editor="session.document.editor"
      :revision="session.revision"
    />
    <section v-else-if="session.bridgePhase === 'standby'" class="empty-state" role="status">
      <p>{{ session.bridgeDetail }}</p>
    </section>
    <section v-else class="empty-state">
      <div class="empty-card">
        <h1>开始设计</h1>
        <p>新建空白设计或打开本地 .fig / .pen 文件。完成后 Agent 才会连接，并且只操作当前文档。</p>
        <div class="empty-actions">
          <button type="button" class="primary" :disabled="busy" @click="createDocument">新建设计</button>
          <button v-if="!session.binding" type="button" :disabled="busy" @click="chooseFile">打开文件</button>
        </div>
      </div>
    </section>
  </main>
</template>
