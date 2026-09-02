import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConversationController } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import desktopRemote from '@run-bigpig/dsh-desktop-plugin-host/remote'
import type {
  DesktopCapabilities,
  DesktopWindowState,
  DocumentUploadRequest,
  DocumentUploadResult,
  GitCommitRequest,
  GitDiffRequest,
  GitPathRequest,
  GitPathsRequest,
  GitSnapshot,
  McpServerUpsertRequest,
  McpSettingsSnapshot,
  ImageModelSaveRequest,
  ImageModelSettingsSnapshot,
  MarketplaceOperation,
  MarketplaceSnapshot,
  ThinkingDataSaveRequest,
  ThinkingDataSnapshot,
  ThinkingDataTestRequest,
  ThinkingDataTestResult,
  VisionBridgeSnapshot,
  VisionSaveRequest,
  VisionTestRequest,
  VisionTestResult,
  WorkspaceDirectorySnapshot,
  WorkspaceFileSnapshot,
  WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult,
  WorkspaceSearchSnapshot,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import {
  MarketplaceSettingsTab,
  type MarketplaceSettingsTabInjected,
} from './marketplace/MarketplaceSettingsTab.tsx'
import {
  DesktopWindowControls,
  type DesktopWindowControlsInjected,
} from './desktop-window/DesktopWindowControls.tsx'
import { McpSettingsTab, type McpSettingsTabInjected } from './mcp/McpSettingsTab.tsx'
import {
  ThinkingDataSettingsSection, type ThinkingDataSettingsInjected,
} from './thinkingdata/ThinkingDataSettingsSection.tsx'
import { VisionSettingsTab, type VisionSettingsTabInjected } from './vision/VisionSettingsTab.tsx'
import { ImageSettingsTab, type ImageSettingsTabInjected } from './image/ImageSettingsTab.tsx'
import {
  DocumentUploadBridge,
  type DocumentUploadBridgeInjected,
  DocumentUploadButton,
  type DocumentUploadButtonInjected,
  DOCUMENT_REFERENCE_SOURCE,
  documentReferenceOf,
} from './documents/DocumentUploadBridge.tsx'
import {
  DocumentSteeringMessageView,
  DocumentUserMessageView,
  type DocumentMessageInjected,
} from './documents/DocumentMessageView.tsx'
import { ChartPresentationCard } from './chart-presentation/ChartPresentationCard.tsx'
import { ImageToolView } from './image/ImageToolView.tsx'
import {
  ImageResultNode,
  type ImageResultNodeInjected,
  imageResultDefinition,
} from './image/ImageResultNode.tsx'
import {
  ImageStudioInputBridge,
  type ImageStudioInputBridgeInjected,
  MessageImageGallery,
  type MessageImageGalleryInjected,
} from './image/MessageImageGallery.tsx'
import {
  WorkbenchController,
  WorkbenchDrawer,
  type WorkbenchDrawerInjected,
  WorkbenchLauncher,
  type WorkbenchLauncherInjected,
  WorkspaceReferenceDropDock,
  type WorkspaceReferenceDropDockInjected,
  workspaceFileReferenceOf,
} from './workbench/SessionWorkbench.tsx'
import { SkinBrandMark, SkinBrandName } from './skin/SkinBrand.tsx'
import { SkinBackgroundPresenter } from './skin/skin-background.ts'
import { SkinSettingsRow, type SkinSettingsRowInjected } from './skin/SkinSettingsRow.tsx'
import {
  SKIN_SETTINGS_NAMESPACE, SkinController, type SkinPreset, type SkinSettings,
} from './skin/skin-controller.ts'
import {
  desktopEn, desktopZh, documentsEn, documentsZh, en, imageEn, imageZh, mcpEn, mcpZh, skinEn, skinZh,
  thinkingDataEn, thinkingDataZh,
  chartPresentationEn, chartPresentationZh,
  visionEn, visionZh, workbenchEn, workbenchZh, zh,
  type DesktopLocaleKey, type DocumentsLocaleKey, type ImageLocaleKey, type MarketplaceLocaleKey, type McpLocaleKey,
  type ChartPresentationLocaleKey, type SkinLocaleKey, type ThinkingDataLocaleKey, type VisionLocaleKey, type WorkbenchLocaleKey,
} from './locales.ts'
import { applyWebTools, type WebToolsLocaleKey } from './web-tools/client/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.marketplace': MarketplaceLocaleKey
    'settings.mcp': McpLocaleKey
    'settings.thinkingdata': ThinkingDataLocaleKey
    'settings.vision': VisionLocaleKey
    'settings.image': ImageLocaleKey
    'desktop.integration': DesktopLocaleKey
    'documents.upload': DocumentsLocaleKey
    'desktop.workbench': WorkbenchLocaleKey
    'desktop.chartPresentation': ChartPresentationLocaleKey
    'settings.desktopSkin': SkinLocaleKey
    'dsh-web-tools': WebToolsLocaleKey
  }
}

export const NS = 'settings.marketplace'
export const DESKTOP_NS = 'desktop.integration'
export const MCP_NS = 'settings.mcp'
export const THINKINGDATA_NS = 'settings.thinkingdata'
export const VISION_NS = 'settings.vision'
export const IMAGE_NS = 'settings.image'
export const DOCUMENTS_NS = 'documents.upload'
export const WORKBENCH_NS = 'desktop.workbench'
export const CHART_PRESENTATION_NS = 'desktop.chartPresentation'
export const SKIN_NS = 'settings.desktopSkin'
export const inject = ['slots', 'locale', 'remote', 'inputTriggers', 'sessions', 'settingsScope', 'theme']

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

interface ThinkingDataRemote {
  snapshot: () => Promise<RemoteResult<ThinkingDataSnapshot>>
  save: (request: ThinkingDataSaveRequest) => Promise<RemoteResult<{ ok: true }>>
  testConnection: (request: ThinkingDataTestRequest) => Promise<RemoteResult<ThinkingDataTestResult>>
}

interface VisionBridgeRemote {
  snapshot: () => Promise<RemoteResult<VisionBridgeSnapshot>>
  save: (request: VisionSaveRequest) => Promise<RemoteResult<{ ok: true }>>
  testConnection: (request: VisionTestRequest) => Promise<RemoteResult<VisionTestResult>>
}

interface ImageWorkbenchRemote {
  snapshot: () => Promise<RemoteResult<ImageModelSettingsSnapshot>>
  save: (request: ImageModelSaveRequest) => Promise<RemoteResult<{ ok: true }>>
}

interface DocumentsRemote {
  uploadDocument: (request: DocumentUploadRequest) => Promise<RemoteResult<DocumentUploadResult>>
}

interface DesktopWorkspaceRemote {
  listDirectory: (
    sessionId: string,
    directory: string,
    signal: AbortSignal,
  ) => Promise<RemoteResult<WorkspaceDirectorySnapshot>>
  search: (sessionId: string, query: string, signal: AbortSignal) => Promise<RemoteResult<WorkspaceSearchSnapshot>>
  readFile: (sessionId: string, path: string, signal: AbortSignal) => Promise<RemoteResult<WorkspaceFileSnapshot>>
  writeFile: (
    sessionId: string,
    request: WorkspaceFileWriteRequest,
    signal: AbortSignal,
  ) => Promise<RemoteResult<WorkspaceFileWriteResult>>
}

interface DesktopGitRemote {
  snapshot: (sessionId: string, signal: AbortSignal) => Promise<RemoteResult<GitSnapshot>>
  diff: (sessionId: string, request: GitDiffRequest, signal: AbortSignal) => Promise<RemoteResult<string>>
  stage: (sessionId: string, request: GitPathRequest, signal: AbortSignal) => Promise<RemoteResult<GitSnapshot>>
  unstage: (sessionId: string, request: GitPathRequest, signal: AbortSignal) => Promise<RemoteResult<GitSnapshot>>
  stageMany: (sessionId: string, request: GitPathsRequest, signal: AbortSignal) => Promise<RemoteResult<GitSnapshot>>
  unstageMany: (sessionId: string, request: GitPathsRequest, signal: AbortSignal) => Promise<RemoteResult<GitSnapshot>>
  discard: (sessionId: string, request: GitPathsRequest, signal: AbortSignal) => Promise<RemoteResult<GitSnapshot>>
  commit: (sessionId: string, request: GitCommitRequest, signal: AbortSignal) => Promise<RemoteResult<GitSnapshot>>
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
  ctx.effect(() => ctx.locale.register(THINKINGDATA_NS, { zh: thinkingDataZh, en: thinkingDataEn }), 'thinkingdata: dictionaries')
  ctx.effect(() => ctx.locale.register(VISION_NS, { zh: visionZh, en: visionEn }), 'desktop-vision: dictionaries')
  ctx.effect(() => ctx.locale.register(IMAGE_NS, { zh: imageZh, en: imageEn }), 'desktop-image-workbench: dictionaries')
  ctx.effect(() => ctx.locale.register(DOCUMENTS_NS, { zh: documentsZh, en: documentsEn }), 'desktop-documents: dictionaries')
  ctx.effect(() => ctx.locale.register(WORKBENCH_NS, { zh: workbenchZh, en: workbenchEn }), 'desktop-workbench: dictionaries')
  ctx.effect(() => ctx.locale.register(CHART_PRESENTATION_NS, { zh: chartPresentationZh, en: chartPresentationEn }), 'desktop-chart-presentation: dictionaries')
  ctx.effect(() => ctx.locale.register(SKIN_NS, { zh: skinZh, en: skinEn }), 'desktop-skin: dictionaries')
  applyWebTools(ctx)

  const skinScope = ctx.settingsScope.bind<SkinSettings>({ namespace: SKIN_SETTINGS_NAMESPACE })
  const skinBackground = new SkinBackgroundPresenter()
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({
      name: 'sidebar.brand.mark', priority: -10,
      inject: () => ({ scope: skinScope, placement: 'sidebar' as const }),
    }, SkinBrandMark))
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({
      name: 'sidebar.brand.name', priority: -10,
      inject: () => ({ scope: skinScope }),
    }, SkinBrandName))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({
      name: 'conversation.hero.brand.mark', priority: -10,
      inject: () => ({ scope: skinScope, placement: 'hero' as const }),
    }, SkinBrandMark))
  ctx.effect(() => {
    const controller = new SkinController(
      skinScope,
      ctx.theme,
      image => { skinBackground.set(image) },
    )
    return () => {
      controller.dispose()
      skinBackground.dispose()
    }
  }, 'desktop-skin: theme and brand synchronization')
  const skinInjected: SkinSettingsRowInjected = {
    scope: skinScope,
    setEnabled: enabled => skinScope.set('enabled', enabled),
    setPreset: (preset: SkinPreset) => skinScope.set('preset', preset),
    setBackgroundImage: image => skinScope.set('backgroundImage', image),
    setTransparency: transparency => skinScope.set('transparency', transparency),
    clearBackgroundImage: () => skinScope.unset('backgroundImage'),
    setLogoImage: image => skinScope.set('logoImage', image),
    clearLogoImage: () => skinScope.unset('logoImage'),
    setBrandTitle: title => skinScope.set('brandTitle', title),
    setHeroHeadline: headline => skinScope.set('heroHeadline', headline),
    setHeroPreview: preview => skinScope.set('heroPreview', preview),
    reset: async () => {
      await skinScope.unset('enabled')
      await skinScope.unset('preset')
      await skinScope.unset('brand')
      await skinScope.unset('backgroundImage')
      await skinScope.unset('transparency')
      await skinScope.unset('logoImage')
      await skinScope.unset('brandTitle')
      await skinScope.unset('heroHeadline')
      await skinScope.unset('heroPreview')
    },
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'desktop-skin',
    order: 15,
    locale: SKIN_NS,
    inject: (): SkinSettingsRowInjected => skinInjected,
  }, SkinSettingsRow))

  const workbenchController = new WorkbenchController()
  ctx.slots.inject('conversation.message.images', () => ctx.slots.register({
    name: 'conversation.message.images',
    priority: -10,
    locale: WORKBENCH_NS,
    inject: (): MessageImageGalleryInjected => ({ controller: workbenchController }),
  }, MessageImageGallery))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'chart_present',
    locale: CHART_PRESENTATION_NS,
  }, ChartPresentationCard))
  ctx.inject(['remote.mcpSettings', 'remote.visionBridge', 'remote.imageWorkbench'], (inner: ClientContext) => {
    const remotes = inner.remote as ClientContext['remote'] & {
      mcpSettings: McpSettingsRemote
      visionBridge: VisionBridgeRemote
      imageWorkbench: ImageWorkbenchRemote
    }
    const mcpT = inner.locale.bind(MCP_NS)
    const visionT = inner.locale.bind(VISION_NS)
    const imageT = inner.locale.bind(IMAGE_NS)
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
    inner.slots.inject('settings.plugins.tab', () => inner.slots.register({
      name: 'settings.plugins.tab', id: 'image', order: 50, label: () => imageT('tab'), locale: IMAGE_NS,
      inject: (): ImageSettingsTabInjected => ({
        snapshot: async () => unwrap(await remotes.imageWorkbench.snapshot()),
        save: async request => { unwrap(await remotes.imageWorkbench.save(request)) },
      }),
    }, ImageSettingsTab))
  })
  ctx.inject(['remote.thinkingData'], (inner: ClientContext) => {
    const remote = (inner.remote as ClientContext['remote'] & { thinkingData: ThinkingDataRemote }).thinkingData
    const t = inner.locale.bind(THINKINGDATA_NS)
    inner.slots.inject('settings.section', () => inner.slots.register({
      name: 'settings.section', id: 'thinkingdata', order: 35, label: () => t('nav'), locale: THINKINGDATA_NS,
      inject: (): ThinkingDataSettingsInjected => ({
        snapshot: async () => unwrap(await remote.snapshot()),
        save: async request => { unwrap(await remote.save(request)) },
        testConnection: async request => unwrap(await remote.testConnection(request)),
      }),
    }, ThinkingDataSettingsSection))
  })
  ctx.inject(['uiConversation'], (inner: ClientContext) => {
    const imageResultActions: ImageResultNodeInjected = {
      loadImage: (sessionId, attachment) => inner.uiConversation.imageUrl(
        sessionId as Parameters<ClientContext['uiConversation']['imageUrl']>[0],
        attachment,
      ),
      controller: workbenchController,
    }
    inner.uiConversation.events.register(imageResultDefinition)
    inner.slots.inject('conversation.chat.node', () => inner.slots.register({
      name: 'conversation.chat.node',
      key: 'image-results',
      locale: WORKBENCH_NS,
      inject: (): ImageResultNodeInjected => imageResultActions,
    }, ImageResultNode))
    for (const key of ['image_generate', 'image_edit', 'image_task_continue', 'image_task_get', 'image_versions']) {
      inner.slots.inject('tool.call.toolview', () => inner.slots.register({
        name: 'tool.call.toolview',
        key,
        locale: WORKBENCH_NS,
      }, ImageToolView))
    }
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
    inner.slots.inject('conversation.chat.node', () => inner.slots.register({
      name: 'conversation.chat.node',
      key: 'user',
      priority: -10,
      locale: 'chat',
      inject: (): DocumentMessageInjected => ({ documentT }),
    }, DocumentUserMessageView))
    inner.slots.inject('conversation.chat.node', () => inner.slots.register({
      name: 'conversation.chat.node',
      key: 'steering',
      priority: -10,
      locale: 'chat',
      inject: (): DocumentMessageInjected => ({ documentT }),
    }, DocumentSteeringMessageView))
  })
  ctx.inject(['remote.desktopWorkspace', 'remote.desktopGit', 'remote.imageWorkbench', 'conversation', 'sessions'], (inner: ClientContext) => {
    const remotes = inner.remote as ClientContext['remote'] & {
      desktopWorkspace: DesktopWorkspaceRemote
      desktopGit: DesktopGitRemote
      imageWorkbench: ImageWorkbenchRemote
    }
    const workspace = remotes.desktopWorkspace
    const git = remotes.desktopGit
    const conversation = inner.get('conversation') as ConversationController | undefined
    if (conversation === undefined) throw new Error('desktop-image-workbench: Harness conversation service is unavailable')
    const imageInserters = new Map<string, (instruction: string, file: File) => boolean>()
    inner.slots.inject('conversation.session.header.utilities', () => inner.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'desktop-session-workbench-launcher',
      order: 10,
      locale: WORKBENCH_NS,
      inject: (): WorkbenchLauncherInjected => ({ controller: workbenchController }),
    }, WorkbenchLauncher))
    inner.slots.inject('shell.overlay', () => inner.slots.register({
      name: 'shell.overlay',
      id: 'desktop-session-workbench',
      order: 20,
      locale: WORKBENCH_NS,
      inject: (): WorkbenchDrawerInjected => ({
        controller: workbenchController,
        listDirectory: async (sessionId, directory, signal) =>
          unwrap(await workspace.listDirectory(sessionId, directory, signal)),
        searchWorkspace: async (sessionId, query, signal) =>
          unwrap(await workspace.search(sessionId, query, signal)),
        readWorkspaceFile: async (sessionId, path, signal) =>
          unwrap(await workspace.readFile(sessionId, path, signal)),
        writeWorkspaceFile: async (sessionId, request, signal) =>
          unwrap(await workspace.writeFile(sessionId, request, signal)),
        gitActions: sessionId => ({
          snapshot: async signal => unwrap(await git.snapshot(sessionId, signal)),
          diff: async (path, staged, signal) => unwrap(await git.diff(sessionId, { path, staged }, signal)),
          stage: async (path, signal) => unwrap(await git.stage(sessionId, { path }, signal)),
          unstage: async (path, signal) => unwrap(await git.unstage(sessionId, { path }, signal)),
          stageMany: async (paths, signal) => unwrap(await git.stageMany(sessionId, { paths }, signal)),
          unstageMany: async (paths, signal) => unwrap(await git.unstageMany(sessionId, { paths }, signal)),
          discard: async (paths, signal) => unwrap(await git.discard(sessionId, { paths }, signal)),
          commit: async (message, signal) => unwrap(await git.commit(sessionId, { message }, signal)),
        }),
        submitImageEdit: (sessionId, instruction, file) => imageInserters.get(sessionId)?.(instruction, file) ?? false,
      }),
    }, WorkbenchDrawer))
    inner.slots.inject('conversation.input.dock', () => inner.slots.register({
      name: 'conversation.input.dock',
      id: 'desktop-image-studio-input-bridge',
      order: 950,
      inject: (): ImageStudioInputBridgeInjected => ({
        bindInserter: (boundSessionId, insert) => {
          imageInserters.set(boundSessionId, insert)
          return () => { if (imageInserters.get(boundSessionId) === insert) imageInserters.delete(boundSessionId) }
        },
        createDraftImages: files => conversation.createDraftImages(files),
        releaseDraftImage: id => { conversation.releaseDraftImage(id) },
      }),
    }, ImageStudioInputBridge))
    inner.slots.inject('conversation.input.dock', () => inner.slots.register({
      name: 'conversation.input.dock',
      id: 'desktop-workspace-reference-drop',
      order: 900,
      locale: WORKBENCH_NS,
      inject: (sessionId): WorkspaceReferenceDropDockInjected => ({
        controller: workbenchController,
        insertFile: (path, span) => {
          const reference = workspaceFileReferenceOf(path)
          if (reference === undefined) return false
          const actx = inner.sessions.scope(sessionId)
          if (actx === undefined) return false
          return actx.bail(actx, 'slash/input-insert-reference', { reference, span }) === true
        },
      }),
    }, WorkspaceReferenceDropDock))
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
