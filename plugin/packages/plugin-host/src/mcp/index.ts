import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context, Service, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  applyMcpSystemOverride,
  countMcpTools,
  emptyMcpSettingsDocument,
  isReservedMcpServerName,
  MCP_CLIENT_MODULE,
  parseMcpSettingsDocument,
  removeMcpServerRecord,
  serializeMcpSettingsDocument,
  toMcpClientConfig,
  updateMcpSystemOverride,
  upsertMcpServerRecord,
  viewCompositionConfig,
  viewMcpServerRecord,
  type McpServerRecord,
  type McpSettingsDocument,
} from './document.ts'
import type {
  McpServerFiberPhase,
  McpServerRemoveRequest,
  McpServerUpsertRequest,
  McpServerView,
  McpSettingsMutationResult,
  McpSettingsSnapshot,
  McpSystemUpdateRequest,
} from '../shared/types.ts'

export interface McpSettingsConfig {
  readonly path: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpSettings: McpSettingsGateway
  }
}

const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, McpServerFiberPhase>

export class McpSettingsGateway extends TypertRemoteService {
  static inject = ['tools']
  static Config: z<McpSettingsConfig> = z.object({ path: z.string().required() })

  private readonly filename: string
  private document: McpSettingsDocument = emptyMcpSettingsDocument()
  private readonly fibers = new Map<string, Fiber>()
  private readonly systemRecords = new Map<string, McpServerRecord>()
  private chain: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: McpSettingsConfig) {
    super(ctx, 'mcpSettings')
    this.filename = resolve(config.path)
  }

  protected async [Service.init](): Promise<void> {
    this.document = await this.readDocument()
    this.syncAll()
    this.ctx.effect(() => async () => {
      for (const name of [...this.fibers.keys()]) await this.dropFiber(name)
    }, 'desktop-mcp: dispose children')
  }

  @Remote('list')
  list(): Promise<McpSettingsSnapshot> {
    return this.enqueue(() => Promise.resolve({ servers: this.snapshot() }))
  }

  @Remote('upsert')
  upsert(request: McpServerUpsertRequest): Promise<McpSettingsMutationResult> {
    return this.enqueue(async () => {
      this.assertNotComposition(request.serverName, 'upsert')
      const fromName = request.fromServerName
      if (fromName !== undefined && fromName !== request.serverName) {
        this.assertNotComposition(fromName, 'upsert')
      }
      this.document = upsertMcpServerRecord(this.document, request)
      await this.persist()
      if (fromName !== undefined && fromName !== request.serverName) await this.dropFiber(fromName)
      const record = this.document.servers.find(server => server.serverName === request.serverName)
      if (record === undefined) throw new Error(`mcp-settings: failed to persist ${JSON.stringify(request.serverName)}`)
      await this.syncRecord(record)
      return { ok: true }
    })
  }

  @Remote('updateSystem')
  updateSystem(request: McpSystemUpdateRequest): Promise<McpSettingsMutationResult> {
    return this.enqueue(async () => {
      if (!isReservedMcpServerName(request.serverName) || !this.systemRecords.has(request.serverName)) {
        throw new Error(`mcp-settings: no system server named ${JSON.stringify(request.serverName)}`)
      }
      if ((request.url !== undefined || request.headers !== undefined) && request.serverName !== 'ta-mcp-server') {
        throw new Error(`mcp-settings: connection settings for ${JSON.stringify(request.serverName)} are runtime-managed`)
      }
      this.document = updateMcpSystemOverride(this.document, request)
      await this.persist()
      await this.syncSystem(request.serverName)
      return { ok: true }
    })
  }

  @Remote('delete')
  delete(request: McpServerRemoveRequest): Promise<McpSettingsMutationResult> {
    return this.enqueue(async () => {
      this.assertNotComposition(request.serverName, 'delete')
      if (!this.document.servers.some(server => server.serverName === request.serverName)) {
        throw new Error(`mcp-settings: no Settings-owned server named ${JSON.stringify(request.serverName)}`)
      }
      this.document = removeMcpServerRecord(this.document, request.serverName)
      await this.persist()
      await this.dropFiber(request.serverName)
      return { ok: true }
    })
  }

  private snapshot(): McpServerView[] {
    const toolNames = this.toolNames()
    const settings = this.document.servers.filter(record => !isReservedMcpServerName(record.serverName)).map(record => viewMcpServerRecord(
      record,
      'settings',
      fiberPhase(this.fibers.get(record.serverName)),
      countMcpTools(toolNames, record.serverName),
    ))
    const systems = [...this.systemRecords.values()].map(record => viewMcpServerRecord(
      applyMcpSystemOverride(record, this.document),
      'system',
      fiberPhase(this.fibers.get(record.serverName)),
      countMcpTools(toolNames, record.serverName),
    ))
    return [...systems, ...settings, ...this.compositionViews(toolNames)]
  }

  private compositionViews(toolNames: readonly string[] = this.toolNames()): McpServerView[] {
    const views: McpServerView[] = []
    for (const entry of this.loaderEntries()) {
      if (entry.options.name !== MCP_CLIENT_MODULE) continue
      const view = viewCompositionConfig(entry.options.config, !entry.disabled, fiberPhase(entry.fiber), toolNames)
      if (view !== null && !this.systemRecords.has(view.serverName)) views.push(view)
    }
    return views
  }

  private toolNames(): readonly string[] {
    return this.ctx.tools.schemas().map(schema => schema.name)
  }

  private compositionNames(): Set<string> {
    return new Set(this.compositionViews().map(view => view.serverName))
  }

  private assertNotComposition(serverName: string, action: 'upsert' | 'delete'): void {
    if (isReservedMcpServerName(serverName)) {
      throw new Error(`mcp-settings: cannot ${action} reserved server ${JSON.stringify(serverName)}`)
    }
    if (this.compositionNames().has(serverName)) {
      throw new Error(`mcp-settings: cannot ${action} ${JSON.stringify(serverName)} because a composition owns it`)
    }
  }

  private syncAll(): void {
    const compositionNames = this.compositionNames()
    for (const record of this.document.servers) {
      if (record.enabled && !isReservedMcpServerName(record.serverName) && !compositionNames.has(record.serverName)) this.mount(record)
    }
  }

  setSystem(record: McpServerRecord): Promise<void> {
    return this.enqueue(async () => {
      if (!isReservedMcpServerName(record.serverName)) {
        throw new Error(`mcp-settings: ${JSON.stringify(record.serverName)} is not a system server`)
      }
      const next = { ...record, enabled: true }
      const previous = this.systemRecords.get(record.serverName)
      this.systemRecords.set(record.serverName, next)
      if (previous === undefined || !sameRecord(
        applyMcpSystemOverride(previous, this.document),
        applyMcpSystemOverride(next, this.document),
      )) {
        await this.syncSystem(record.serverName)
      }
    })
  }

  removeSystem(serverName: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.systemRecords.delete(serverName)) return
      await this.dropFiber(serverName)
    })
  }

  systemPhase(serverName: string): McpServerFiberPhase {
    return fiberPhase(this.fibers.get(serverName))
  }

  private async syncSystem(serverName: string): Promise<void> {
    await this.dropFiber(serverName)
    const record = this.systemRecords.get(serverName)
    if (record !== undefined) this.mount(applyMcpSystemOverride(record, this.document))
  }

  private async syncRecord(record: McpServerRecord): Promise<void> {
    await this.dropFiber(record.serverName)
    if (record.enabled && !this.compositionNames().has(record.serverName)) this.mount(record)
  }

  private mount(record: McpServerRecord): void {
    const fiber = this.ctx.plugin({
      name: mcpClient.name,
      inject: mcpClient.inject,
      Config: mcpClient.Config,
      apply: mcpClient.apply,
    }, toMcpClientConfig(record))
    this.fibers.set(record.serverName, fiber)
    void Promise.resolve(fiber).catch((error: unknown) => { this.ctx.logger.warn(error) })
  }

  private async dropFiber(serverName: string): Promise<void> {
    const fiber = this.fibers.get(serverName)
    if (fiber === undefined) return
    this.fibers.delete(serverName)
    await fiber.dispose()
  }

  private async readDocument(): Promise<McpSettingsDocument> {
    try {
      return parseMcpSettingsDocument(await readFile(this.filename, 'utf8'))
    } catch (error) {
      if (isEnoent(error)) return emptyMcpSettingsDocument()
      throw error
    }
  }

  private async persist(): Promise<void> {
    await writeFileAtomic(this.filename, serializeMcpSettingsDocument(this.document), {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  private loaderEntries(): Iterable<{
    readonly options: { readonly name: string; readonly config?: unknown }
    readonly disabled?: boolean | null
    readonly fiber?: Fiber
  }> {
    return this.ctx.get('loader')?.entries() ?? []
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

function fiberPhase(fiber: Fiber | undefined): McpServerFiberPhase {
  return fiber === undefined ? null : FIBER_PHASE[fiber.state]
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function sameRecord(left: McpServerRecord, right: McpServerRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export default McpSettingsGateway
