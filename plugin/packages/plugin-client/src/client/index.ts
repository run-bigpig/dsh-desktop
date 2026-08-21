import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import desktopRemote from '@run-bigpig/dsh-desktop-plugin-host/remote'
import type {
  DesktopCapabilities,
  DesktopWindowState,
  DocumentUploadRequest,
  DocumentUploadResult,
  McpServerUpsertRequest,
  McpSettingsSnapshot,
  MarketplaceOperation,
  MarketplaceSnapshot,
  VisionBridgeSnapshot,
  VisionSaveRequest,
  VisionTestRequest,
  VisionTestResult,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import {
  MarketplaceSettingsTab,
  type MarketplaceSettingsTabInjected,
} from './MarketplaceSettingsTab.tsx'
import {
  DesktopWindowControls,
  type DesktopWindowControlsInjected,
} from './DesktopWindowControls.tsx'
import { McpSettingsTab, type McpSettingsTabInjected } from './McpSettingsTab.tsx'
import { VisionSettingsTab, type VisionSettingsTabInjected } from './VisionSettingsTab.tsx'
import {
  DocumentUploadBridge,
  type DocumentUploadBridgeInjected,
  DocumentUploadButton,
  type DocumentUploadButtonInjected,
  DOCUMENT_REFERENCE_SOURCE,
  documentReferenceOf,
} from './DocumentUploadBridge.tsx'
import { DocumentMessageView, type DocumentMessageInjected } from './DocumentMessageView.tsx'
import { ThinkingLevelSection } from './ThinkingLevelSection.tsx'
import {
  LLM_PI_AI_NS,
  THINKING_OVERRIDE_NS,
  ThinkingOverrideSectionController,
  type ReasoningEfforts,
} from './thinking-level-controller.ts'
import { en as thinkingEn, zh as thinkingZh, type Dictionary as ThinkingLocaleKey } from './thinking-level-locales.ts'
import {
  desktopEn, desktopZh, documentsEn, documentsZh, en, mcpEn, mcpZh, visionEn, visionZh, zh,
  type DesktopLocaleKey, type DocumentsLocaleKey, type MarketplaceLocaleKey, type McpLocaleKey, type VisionLocaleKey,
} from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.marketplace': MarketplaceLocaleKey
    'settings.mcp': McpLocaleKey
    'settings.vision': VisionLocaleKey
    'desktop.integration': DesktopLocaleKey
    'documents.upload': DocumentsLocaleKey
    'thinking-level-override': ThinkingLocaleKey
  }
}

export const NS = 'settings.marketplace'
export const DESKTOP_NS = 'desktop.integration'
export const MCP_NS = 'settings.mcp'
export const VISION_NS = 'settings.vision'
export const DOCUMENTS_NS = 'documents.upload'
export const THINKING_NS = 'thinking-level-override'
export const inject = ['slots', 'locale', 'remote', 'connection', 'settingsScope', 'inputTriggers', 'sessions']

interface DesktopRemote {
  capabilities: () => Promise<RemoteResult<DesktopCapabilities>>
  windowState: () => Promise<RemoteResult<DesktopWindowState>>
  minimizeWindow: () => Promise<RemoteResult<void>>
  toggleMaximizeWindow: () => Promise<RemoteResult<DesktopWindowState>>
  closeWindow: () => Promise<RemoteResult<void>>
  catalog: () => Promise<{ ok: true; value: MarketplaceSnapshot } | { ok: false; error: { code: string; message: string } }>
  mutate: (request: Parameters<MarketplaceSettingsTabInjected['mutate']>[0]) => Promise<
    { ok: true; value: MarketplaceOperation } | { ok: false; error: { code: string; message: string } }
  >
  activeOperation: () => Promise<
    { ok: true; value: MarketplaceOperation | null } | { ok: false; error: { code: string; message: string } }
  >
  operation: (id: string) => Promise<
    { ok: true; value: MarketplaceOperation } | { ok: false; error: { code: string; message: string } }
  >
}

interface McpSettingsRemote {
  list: () => Promise<RemoteResult<McpSettingsSnapshot>>
  upsert: (request: McpServerUpsertRequest) => Promise<RemoteResult<{ ok: true }>>
  delete: (request: { serverName: string }) => Promise<RemoteResult<{ ok: true }>>
}

interface VisionBridgeRemote {
  snapshot: () => Promise<RemoteResult<VisionBridgeSnapshot>>
  save: (request: VisionSaveRequest) => Promise<RemoteResult<{ ok: true }>>
  testConnection: (request: VisionTestRequest) => Promise<RemoteResult<VisionTestResult>>
}

interface DocumentsRemote {
  uploadDocument: (request: DocumentUploadRequest) => Promise<RemoteResult<DocumentUploadResult>>
}

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

const CAPABILITY_RETRY_DELAYS_MS = [0, 50, 100, 200, 400, 800]

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

async function discoverCapabilities(remote: DesktopRemote): Promise<DesktopCapabilities> {
  let lastError: Error | undefined
  for (const delay of CAPABILITY_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    const result = await remote.capabilities()
    if (result.ok) return result.value
    lastError = new Error(`${result.error.code}: ${result.error.message}`)
  }
  throw lastError ?? new Error('Desktop capabilities are unavailable')
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(desktopRemote)
  const remote = ctx.get('remote.desktop') as DesktopRemote | undefined
  if (remote === undefined) {
    await disposeRemote()
    throw new Error('Desktop Remote namespace did not start')
  }
  let capabilities: DesktopCapabilities
  try {
    capabilities = await discoverCapabilities(remote)
  } catch {
    capabilities = { apiVersion: 0, capabilities: [] }
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-marketplace: dictionaries')
  ctx.effect(() => ctx.locale.register(DESKTOP_NS, { zh: desktopZh, en: desktopEn }), 'desktop-integration: dictionaries')
  ctx.effect(() => ctx.locale.register(MCP_NS, { zh: mcpZh, en: mcpEn }), 'desktop-mcp: dictionaries')
  ctx.effect(() => ctx.locale.register(VISION_NS, { zh: visionZh, en: visionEn }), 'desktop-vision: dictionaries')
  ctx.effect(() => ctx.locale.register(DOCUMENTS_NS, { zh: documentsZh, en: documentsEn }), 'desktop-documents: dictionaries')
  ctx.effect(() => ctx.locale.register(THINKING_NS, { zh: thinkingZh, en: thinkingEn }), 'desktop-thinking-levels: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const thinkingController = new ThinkingOverrideSectionController(
    ctx.settingsScope.bind({ namespace: THINKING_OVERRIDE_NS }),
    ctx.settingsScope.bind({ namespace: LLM_PI_AI_NS }),
    connection.api,
  )
  const thinkingT = ctx.locale.bind(THINKING_NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'thinking-level-override',
    order: 12,
    label: () => thinkingT('nav'),
    locale: THINKING_NS,
    inject: () => ({
      hooks: {
        thinkingOverridePolicy: thinkingController.policySource,
        piAiSection: thinkingController.piAiSource,
      },
      api: connection.api,
      saveSection: (enableMappings: boolean, changes: Map<string, ReasoningEfforts | undefined>) =>
        thinkingController.save(enableMappings, changes),
    }),
  }, ThinkingLevelSection))
  ctx.inject(['remote.mcpSettings', 'remote.visionBridge'], (inner: ClientContext) => {
    const remotes = inner.remote as ClientContext['remote'] & {
      mcpSettings: McpSettingsRemote
      visionBridge: VisionBridgeRemote
    }
    const mcpT = inner.locale.bind(MCP_NS)
    const visionT = inner.locale.bind(VISION_NS)
    inner.slots.inject('settings.plugins.tab', () => inner.slots.register({
      name: 'settings.plugins.tab', id: 'mcp', order: 30, label: () => mcpT('tab'), locale: MCP_NS,
      inject: (): McpSettingsTabInjected => ({
        list: async () => unwrap(await remotes.mcpSettings.list()),
        upsert: async request => { unwrap(await remotes.mcpSettings.upsert(request)) },
        remove: async serverName => { unwrap(await remotes.mcpSettings.delete({ serverName })) },
      }),
    }, McpSettingsTab))
    inner.slots.inject('settings.plugins.tab', () => inner.slots.register({
      name: 'settings.plugins.tab', id: 'vision', order: 40, label: () => visionT('tab'), locale: VISION_NS,
      inject: (): VisionSettingsTabInjected => ({
        snapshot: async () => unwrap(await remotes.visionBridge.snapshot()),
        save: async request => { unwrap(await remotes.visionBridge.save(request)) },
        testConnection: async request => unwrap(await remotes.visionBridge.testConnection(request)),
      }),
    }, VisionSettingsTab))
  })
  ctx.inject(['remote.documents', 'inputTriggers', 'sessions'], (inner: ClientContext) => {
    const documents = (inner.remote as ClientContext['remote'] & { documents: DocumentsRemote }).documents
    const inputTriggers = inner.get('inputTriggers') as InputTriggerServiceContract
    const pickers = new Map<string, () => void>()
    inner.effect(() => inputTriggers.registerSource({
      trigger: '@',
      name: DOCUMENT_REFERENCE_SOURCE,
      order: 1000,
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      codec: {
        clipboardText: ref => ref,
        serialize: ref => Promise.resolve(ref),
      },
    } satisfies InputTriggerSource), 'desktop-documents: reference codec')
    inner.slots.inject('conversation.input.dock', () => inner.slots.register({
      name: 'conversation.input.dock',
      id: 'desktop-document-attachments',
      order: 1000,
      locale: DOCUMENTS_NS,
      inject: (sessionId): DocumentUploadBridgeInjected => ({
        uploadDocument: async request => unwrap(await documents.uploadDocument(request)),
        insertDocument: (document, span) => {
          const actx = inner.sessions.scope(sessionId)
          if (actx === undefined) return false
          return actx.bail(actx, 'slash/input-insert-reference', {
            reference: documentReferenceOf(document),
            span,
          }) === true
        },
        bindPicker: open => {
          const key = String(sessionId)
          pickers.set(key, open)
          return () => {
            if (pickers.get(key) === open) pickers.delete(key)
          }
        },
      }),
    }, DocumentUploadBridge))
    inner.slots.inject('conversation.input.left', () => inner.slots.register({
      name: 'conversation.input.left',
      id: 'desktop-document-upload-button',
      order: -100,
      locale: DOCUMENTS_NS,
      inject: (sessionId): DocumentUploadButtonInjected => ({
        openPicker: () => { pickers.get(String(sessionId))?.() },
      }),
    }, DocumentUploadButton))
    const documentT = inner.locale.bind(DOCUMENTS_NS)
    for (const key of ['user', 'steering'] as const) {
      inner.slots.inject('conversation.chat.node', () => inner.slots.register({
        name: 'conversation.chat.node',
        key,
        priority: -10,
        locale: 'conversation',
        inject: (): DocumentMessageInjected => ({ documentT }),
      }, DocumentMessageView))
    }
  })
  if (capabilities.apiVersion === 1 && capabilities.capabilities.includes('marketplace')) {
    const t = ctx.locale.bind(NS)
    const injected: MarketplaceSettingsTabInjected = {
      catalog: async (): Promise<MarketplaceSnapshot> => unwrap(await remote.catalog()),
      mutate: async request => unwrap(await remote.mutate(request)),
      activeOperation: async (): Promise<MarketplaceOperation | null> => unwrap(await remote.activeOperation()),
      operation: async (id: string): Promise<MarketplaceOperation> => unwrap(await remote.operation(id)),
    }
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'market',
      order: 20,
      label: () => t('tab'),
      locale: NS,
      inject: () => injected,
    }, MarketplaceSettingsTab))
  }
  if (capabilities.apiVersion === 1 && capabilities.capabilities.includes('window.controls')) {
    const windowActions: DesktopWindowControlsInjected = {
      windowState: async () => unwrap(await remote.windowState()),
      minimizeWindow: async () => { unwrap(await remote.minimizeWindow()) },
      toggleMaximizeWindow: async () => unwrap(await remote.toggleMaximizeWindow()),
      closeWindow: async () => { unwrap(await remote.closeWindow()) },
    }
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'desktop-window-controls',
      order: -100,
      locale: DESKTOP_NS,
      inject: () => windowActions,
    }, DesktopWindowControls))
  }
  return disposeRemote
}
