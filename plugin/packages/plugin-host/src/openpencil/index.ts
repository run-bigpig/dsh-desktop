import { Context, Service, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { desktopRequest } from '../desktop/index.ts'
import { countMcpTools } from '../mcp/document.ts'
import type { OpenPencilPhase, OpenPencilSnapshot } from '../shared/types.ts'
import { defineOpenPencilControlTools } from './control-tools.ts'
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

interface DesktopOpenPencilStatus {
  readonly bundled: boolean
  readonly running: boolean
  readonly owned: boolean
  readonly port?: number
  readonly url?: string
  readonly token?: string
  readonly version?: string
}

export class OpenPencilGateway extends TypertRemoteService {
  static inject = ['tools', 'skills']

  private fiber: Fiber | undefined
  private disposeSkill: (() => void) | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'openPencil')
  }

  protected async [Service.init](): Promise<void> {
    this.disposeSkill = await registerOpenPencilSkill(this.ctx)
    for (const tool of defineOpenPencilControlTools({
      show: () => this.showCanvas(),
      hide: () => this.hideCanvas(),
    })) {
      this.ctx.effect(() => this.ctx.tools.register(tool), `openpencil: ${tool.name} tool`)
    }
    try {
      const status = await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/status')
      if (status.running) await this.mount(status)
    } catch (error) {
      this.ctx.logger.warn(error)
    }
    this.ctx.effect(() => () => this.dropRuntime(), 'openpencil: dispose runtime')
  }

  @Remote('snapshot')
  snapshot(): Promise<OpenPencilSnapshot> {
    return this.enqueue(async () => {
      const status = await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/status')
      if (!status.running && this.fiber !== undefined) await this.dropFiber()
      if (status.running && this.fiber === undefined) await this.mount(status)
      return this.sanitized(status)
    })
  }

  private showCanvas(): Promise<string> {
    return this.enqueue(async () => {
      const status = await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/show', { method: 'POST' })
      if (this.fiber === undefined) await this.mount(status)
      return 'OpenPencil canvas is visible. Its built-in MCP connection remains managed by StarWeave.'
    })
  }

  private hideCanvas(): Promise<string> {
    return this.enqueue(async () => {
      await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/hide', { method: 'POST' })
      return 'OpenPencil canvas is hidden. Its MCP connection remains active in the background.'
    })
  }

  private async mount(status: DesktopOpenPencilStatus): Promise<void> {
    if (this.fiber !== undefined) return
    if (status.url === undefined || status.token === undefined) {
      throw new Error('OpenPencil managed MCP discovery is incomplete')
    }
    this.fiber = this.ctx.plugin({
      name: mcpClient.name,
      inject: mcpClient.inject,
      Config: mcpClient.Config,
      apply: mcpClient.apply,
    }, {
      transport: 'streamable-http',
      serverName: MCP_SERVER_NAME,
      url: status.url,
      headers: { Authorization: `Bearer ${status.token}` },
      toolCallTimeoutMs: 120_000,
      failOnStartupError: false,
    })
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
      phase,
      mcpConnected: phase === 'active',
      toolCount: this.fiber === undefined ? 0 : countMcpTools(toolNames, MCP_SERVER_NAME),
    }
  }

  private phase(status: DesktopOpenPencilStatus): OpenPencilPhase {
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

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

export default OpenPencilGateway
