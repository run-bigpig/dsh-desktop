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

export type OpenPencilPhase = 'disabled' | 'app-stopped' | 'connecting' | 'active' | 'failed'

export interface OpenPencilSnapshot {
  readonly bundled: boolean
  readonly running: boolean
  readonly owned: boolean
  readonly port: number | null
  readonly enabled: boolean
  readonly phase: OpenPencilPhase
  readonly mcpConnected: boolean
  readonly toolCount: number
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

export type ThinkingDataConnectionPhase =
  | 'disabled'
  | 'missing-token'
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'

export interface ThinkingDataSnapshot {
  readonly enabled: boolean
  readonly url: string
  readonly effectiveUrl: string
  readonly tokenConfigured: boolean
  readonly phase: ThinkingDataConnectionPhase
}

export interface ThinkingDataSaveRequest {
  readonly enabled: boolean
  readonly url: string
  readonly token?: string
}

export interface ThinkingDataTestRequest {
  readonly url: string
  readonly token?: string
}

export type ThinkingDataTestStatus = 'ready' | 'connected' | 'missing-token' | 'unauthorized' | 'not-ready' | 'unreachable'

export interface ThinkingDataTestResult {
  readonly ok: boolean
  readonly status: ThinkingDataTestStatus
}

export interface VisionEndpointView {
  readonly provider: string
  readonly model: string
}

export interface LegacyVisionEndpointView {
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
  readonly legacyVision?: LegacyVisionEndpointView
  readonly targets: readonly VisionTargetView[]
  readonly catalog: readonly VisionCatalogGroup[]
}

export interface VisionEndpointSave {
  readonly provider: string
  readonly model: string
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
  readonly provider: string
  readonly model: string
}

export type VisionTestResult =
  | { readonly kind: 'ok'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

export interface ImageModelSelectionView {
  readonly provider: string
  readonly model: string
}

export interface ImageModelCapabilitiesView {
  readonly adapter: 'openai-images' | 'gemini-native-image'
  readonly generate: true
  readonly edit: true
  readonly aspectRatios?: readonly string[]
  readonly resolutions?: readonly ('1K' | '2K' | '4K')[]
  readonly sizes?: readonly string[]
  readonly customSize?: boolean
}

export interface ImageModelCatalogEntry {
  readonly id: string
  readonly name: string
  readonly capabilities: ImageModelCapabilitiesView
}

export interface ImageModelCatalogGroup {
  readonly provider: string
  readonly providerName: string
  readonly models: readonly ImageModelCatalogEntry[]
}

export interface ImageModelSettingsSnapshot {
  readonly image: ImageModelSelectionView
  readonly catalog: readonly ImageModelCatalogGroup[]
}

export interface ImageModelSaveRequest {
  readonly provider: string
  readonly model: string
}

export interface ImageSettingsMutationResult {
  readonly ok: true
}

export interface StoredImageView {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

export interface ImageCanvasGeometry {
  readonly width: number
  readonly height: number
  readonly sourceX: number
  readonly sourceY: number
  readonly sourceWidth: number
  readonly sourceHeight: number
}

export type ImageAnnotationTool =
  | 'rectangle'
  | 'ellipse'
  | 'brush'
  | 'highlight'
  | 'arrow'
  | 'text'
  | 'cross'
  | 'extension'

export interface ImageAnnotationPoint {
  readonly x: number
  readonly y: number
}

export interface ImageAnnotation {
  readonly id: string
  readonly tool: ImageAnnotationTool
  readonly color: string
  readonly strokeWidth: number
  readonly points: readonly ImageAnnotationPoint[]
  readonly text?: string
}

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

export interface WorkspaceEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly size: number
  readonly mtime: number
}

export interface WorkspaceDirectorySnapshot {
  readonly rootName: string
  readonly directory: string
  readonly entries: readonly WorkspaceEntry[]
}

export interface WorkspaceSearchHit {
  readonly name: string
  readonly path: string
  readonly kind: 'file' | 'directory'
}

export interface WorkspaceSearchSnapshot {
  readonly query: string
  readonly hits: readonly WorkspaceSearchHit[]
  readonly truncated: boolean
}

export interface WorkspaceFileSnapshot {
  readonly path: string
  readonly content: string
  readonly encoding: 'utf8' | 'data-url'
  readonly mediaType: string
  readonly size: number
  readonly mtime: number
  readonly truncated: boolean
}

export interface WorkspaceFileWriteRequest {
  readonly path: string
  readonly content: string
  readonly baseMtime?: number
}

export interface WorkspaceFileWriteResult {
  readonly path: string
  readonly mtime: number
}

export type ChartPresentationView = 'line' | 'bar' | 'funnel' | 'heatmap' | 'sankey' | 'table'

export interface ChartPresentationSeries {
  readonly name: string
  readonly values: readonly (number | null)[]
  readonly format?: 'number' | 'percent'
}

export interface ChartCartesianPayload {
  readonly labels: readonly string[]
  readonly series: readonly ChartPresentationSeries[]
}

export interface ChartFunnelStep {
  readonly label: string
  readonly value: number
}

export interface ChartFunnelPayload {
  readonly steps: readonly ChartFunnelStep[]
}

export interface ChartHeatmapRow {
  readonly label: string
  readonly initial?: number
  readonly values: readonly (number | null)[]
}

export interface ChartHeatmapPayload {
  readonly columns: readonly string[]
  readonly rows: readonly ChartHeatmapRow[]
  readonly format: 'number' | 'percent'
}

export interface ChartSankeyLink {
  readonly source: string
  readonly target: string
  readonly value: number
}

export interface ChartSankeyPayload {
  readonly links: readonly ChartSankeyLink[]
}

export type ChartTableCell = string | number | boolean | null

export interface ChartTablePayload {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly ChartTableCell[])[]
}

export type ChartPresentationPayload =
  | ChartCartesianPayload
  | ChartFunnelPayload
  | ChartHeatmapPayload
  | ChartSankeyPayload
  | ChartTablePayload

export interface ChartPresentationModel {
  readonly schemaVersion: 1
  readonly view: ChartPresentationView
  readonly title: string
  readonly source?: string
  readonly generatedAt?: string
  readonly truncated: boolean
  readonly payload: ChartPresentationPayload
}

export interface GitFileState {
  readonly path: string
  readonly fromPath?: string
  readonly index: string
  readonly worktree: string
}

export interface GitSnapshot {
  readonly available: boolean
  readonly repository: boolean
  readonly branch: string | null
  readonly files: readonly GitFileState[]
}

export interface GitPathRequest {
  readonly path: string
}

export interface GitPathsRequest {
  readonly paths: readonly string[]
}

export interface GitDiffRequest extends GitPathRequest {
  readonly staged: boolean
}

export interface GitCommitRequest {
  readonly message: string
}
