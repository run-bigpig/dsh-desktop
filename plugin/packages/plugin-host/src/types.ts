export type MarketplaceOperationAction = 'install' | 'update' | 'uninstall'
export type MarketplaceOperationPhase =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'staging'
  | 'installing'
  | 'validating'
  | 'ready-to-restart'
  | 'restarting'
  | 'completed'
  | 'failed'
  | 'rolled-back'

export interface MarketplacePlugin {
  id: string
  name: string
  description: string
  publisher: string
  packageName: string
  repositoryURL: string
  version: string
  installedVersion: string | null
  updateAvailable: boolean
  permissions: string[]
  license: string
}

export interface MarketplaceSnapshot {
  plugins: MarketplacePlugin[]
  catalogVerified: boolean
  generatedAt: string
  warning: string | null
}

export interface MarketplaceOperation {
  id: string
  pluginId: string
  action: MarketplaceOperationAction
  phase: MarketplaceOperationPhase
  progress: number
  message: string
  error: string | null
}

export interface MarketplaceMutationRequest {
  pluginId: string
  action: MarketplaceOperationAction
}

export interface DesktopCapabilities {
  apiVersion: number
  capabilities: string[]
}

export interface DesktopWindowState {
  maximized: boolean
  fullscreen: boolean
}

export type McpServerOrigin = 'settings' | 'composition'
export type McpServerFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
export type McpServerTransport = 'stdio' | 'streamable-http'

interface McpServerViewBase {
  readonly serverName: string
  readonly origin: McpServerOrigin
  readonly enabled: boolean
  readonly fiberPhase: McpServerFiberPhase
  readonly toolCount: number
  readonly transport: McpServerTransport
  readonly envKeys: readonly string[]
  readonly headerKeys: readonly string[]
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: boolean
}

export interface McpStdioServerView extends McpServerViewBase {
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

export interface McpHttpServerView extends McpServerViewBase {
  readonly transport: 'streamable-http'
  readonly url: string
}

export type McpServerView = McpStdioServerView | McpHttpServerView

export interface McpSettingsSnapshot {
  readonly servers: readonly McpServerView[]
}

export interface McpStdioUpsertRequest {
  readonly transport: 'stdio'
  readonly serverName: string
  readonly fromServerName?: string
  readonly enabled?: boolean
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
  readonly failOnStartupError?: boolean
}

export interface McpHttpUpsertRequest {
  readonly transport: 'streamable-http'
  readonly serverName: string
  readonly fromServerName?: string
  readonly enabled?: boolean
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
  readonly failOnStartupError?: boolean
}

export type McpServerUpsertRequest = McpStdioUpsertRequest | McpHttpUpsertRequest

export interface McpServerRemoveRequest {
  readonly serverName: string
}

export interface McpSettingsMutationResult {
  readonly ok: true
}

export interface VisionEndpointView {
  readonly baseURL: string
  readonly model: string
  readonly hasApiKey: boolean
}

export interface VisionTargetView {
  readonly provider: string
  readonly model: string
  readonly enabled: boolean
}

export interface VisionCatalogModel {
  readonly id: string
  readonly name: string
  readonly nativeVision: boolean
}

export interface VisionCatalogGroup {
  readonly provider: string
  readonly providerName: string
  readonly models: readonly VisionCatalogModel[]
}

export interface VisionBridgeSnapshot {
  readonly vision: VisionEndpointView
  readonly targets: readonly VisionTargetView[]
  readonly catalog: readonly VisionCatalogGroup[]
}

export interface VisionEndpointSave {
  readonly baseURL: string
  readonly model: string
  readonly apiKey?: string
}

export interface VisionTargetSave {
  readonly provider: string
  readonly model: string
  readonly enabled: boolean
}

export interface VisionSaveRequest {
  readonly vision?: VisionEndpointSave
  readonly targets?: readonly VisionTargetSave[]
}

export interface VisionBridgeMutationResult {
  readonly ok: true
}

export interface VisionTestRequest {
  readonly baseURL: string
  readonly model: string
  readonly apiKey?: string
}

export type VisionTestResult =
  | { readonly kind: 'ok'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

export interface DocumentUploadRequest {
  readonly name: string
  readonly mediaType: string
  readonly base64: string
}

export interface DocumentUploadResult {
  readonly id: string
  readonly name: string
  readonly sourceBytes: number
  readonly markdownCharacters: number
  readonly marker: string
}
