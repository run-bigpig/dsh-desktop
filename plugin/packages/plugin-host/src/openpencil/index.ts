import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context, Service, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { desktopRequest } from '../desktop/index.ts'
import { countMcpTools } from '../mcp/document.ts'
import type { OpenPencilPhase, OpenPencilSnapshot } from '../shared/types.ts'
import {
  emptyOpenPencilDocument,
  parseOpenPencilDocument,
  serializeOpenPencilDocument,
  type OpenPencilDocument,
} from './document.ts'
import { registerOpenPencilSkill } from './skill.ts'

const MCP_SERVER_NAME = 'openpencil-mcp'
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

export interface OpenPencilConfig {
  readonly path: string
}

interface DesktopOpenPencilStatus {
  readonly bundled: boolean
  readonly running: boolean
  readonly owned: boolean
  readonly port?: number
  readonly url?: string
  readonly token?: string
}

export class OpenPencilGateway extends TypertRemoteService {
  static inject = ['tools', 'skills']
  static Config: z<OpenPencilConfig> = z.object({ path: z.string().required() })

  private readonly filename: string
  private document: OpenPencilDocument = emptyOpenPencilDocument()
  private fiber: Fiber | undefined
  private disposeSkill: (() => void) | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: OpenPencilConfig) {
    super(ctx, 'openPencil')
    this.filename = resolve(config.path)
  }

  protected async [Service.init](): Promise<void> {
    this.document = await this.readDocument()
    if (this.document.enabled) {
      try {
        const status = await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/status')
        if (status.running) await this.mount(status)
      } catch (error) {
        this.ctx.logger.warn(error)
      }
    }
    this.ctx.effect(() => () => this.dropRuntime(), 'openpencil: dispose runtime')
  }

  @Remote('snapshot')
  snapshot(): Promise<OpenPencilSnapshot> {
    return this.enqueue(async () => {
      const status = await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/status')
      if (this.document.enabled && !status.running && (this.fiber !== undefined || this.disposeSkill !== undefined)) await this.dropRuntime()
      if (this.document.enabled && status.running && this.fiber === undefined) await this.mount(status)
      return this.sanitized(status)
    })
  }

  @Remote('launch')
  launch(): Promise<OpenPencilSnapshot> {
    return this.enqueue(async () => {
      const status = await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/launch', { method: 'POST' })
      if (this.document.enabled) {
        await this.dropRuntime()
        await this.mount(status)
      }
      return this.sanitized(status)
    })
  }

  @Remote('connect')
  connect(): Promise<OpenPencilSnapshot> {
    return this.enqueue(async () => {
      const status = await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/status')
      if (!status.running || status.url === undefined || status.token === undefined) {
        throw new Error('OpenPencil is not running')
      }
      await this.persist({ version: 1, enabled: true })
      this.document = { version: 1, enabled: true }
      await this.dropRuntime()
      await this.mount(status)
      return this.sanitized(status)
    })
  }

  @Remote('disconnect')
  disconnect(): Promise<OpenPencilSnapshot> {
    return this.enqueue(async () => {
      await this.persist({ version: 1, enabled: false })
      this.document = { version: 1, enabled: false }
      await this.dropRuntime()
      return this.sanitized(await desktopRequest('/v1/openpencil/status'))
    })
  }

  private async mount(status: DesktopOpenPencilStatus): Promise<void> {
    if (status.url === undefined || status.token === undefined) return
    const disposeSkill = await registerOpenPencilSkill(this.ctx)
    try {
      this.fiber = this.ctx.plugin({
        name: mcpClient.name,
        inject: mcpClient.inject,
        Config: mcpClient.Config,
        apply: mcpClient.apply,
      }, {
        transport: 'streamable-http',
        serverName: MCP_SERVER_NAME,
        url: status.url,
        headers: { 'X-OpenPencil-Token': status.token },
        toolCallTimeoutMs: 120_000,
        failOnStartupError: false,
      })
      this.disposeSkill = disposeSkill
    } catch (error) {
      disposeSkill()
      throw error
    }
    void Promise.resolve(this.fiber).catch((error: unknown) => { this.ctx.logger.warn(error) })
  }

  private sanitized(status: DesktopOpenPencilStatus): OpenPencilSnapshot {
    const phase = this.phase(status)
    const toolNames = this.ctx.tools.schemas().map(schema => schema.name)
    return {
      bundled: status.bundled,
      running: status.running,
      owned: status.owned,
      port: status.port ?? null,
      enabled: this.document.enabled,
      phase,
      mcpConnected: phase === 'active',
      toolCount: this.fiber === undefined ? 0 : countMcpTools(toolNames, MCP_SERVER_NAME),
    }
  }

  private phase(status: DesktopOpenPencilStatus): OpenPencilPhase {
    if (!this.document.enabled) return 'disabled'
    if (!status.running) return 'app-stopped'
    if (this.fiber === undefined) return 'connecting'
    if (this.fiber.state === FIBER_STATE.ACTIVE) return 'active'
    if (this.fiber.state === FIBER_STATE.FAILED || this.fiber.state === FIBER_STATE.DISPOSED) return 'failed'
    return 'connecting'
  }

  private async dropFiber(): Promise<void> {
    const fiber = this.fiber
    this.fiber = undefined
    if (fiber !== undefined && fiber.state !== FIBER_STATE.DISPOSED) await fiber.dispose()
  }

  private async dropRuntime(): Promise<void> {
    await this.dropFiber()
    this.disposeSkill?.()
    this.disposeSkill = undefined
  }

  private async readDocument(): Promise<OpenPencilDocument> {
    try {
      return parseOpenPencilDocument(await readFile(this.filename, 'utf8'))
    } catch (error) {
      if (isEnoent(error)) return emptyOpenPencilDocument()
      throw error
    }
  }

  private async persist(document: OpenPencilDocument): Promise<void> {
    await writeFileAtomic(this.filename, serializeOpenPencilDocument(document), { mode: 0o600, dirMode: 0o700 })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export default OpenPencilGateway
