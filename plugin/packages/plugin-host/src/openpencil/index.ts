import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { desktopRequest } from '../desktop/index.ts'
import { countMcpTools } from '../mcp/document.ts'
import type { OpenPencilPhase, OpenPencilSnapshot } from '../shared/types.ts'
import { defineOpenPencilControlTools } from './control-tools.ts'
import { registerOpenPencilSkill } from './skill.ts'

const MCP_SERVER_NAME = 'openpencil-mcp'
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
  static inject = ['tools', 'skills', 'mcpSettings']

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
      await this.syncConnection(status)
    } catch (error) {
      this.ctx.logger.warn(error)
    }
    this.ctx.effect(() => () => this.dropRuntime(), 'openpencil: dispose runtime')
  }

  @Remote('snapshot')
  snapshot(): Promise<OpenPencilSnapshot> {
    return this.enqueue(async () => {
      const status = await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/status')
      await this.syncConnection(status)
      return this.sanitized(status)
    })
  }

  private showCanvas(): Promise<string> {
    return this.enqueue(async () => {
      const status = await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/show', { method: 'POST' })
      await this.syncConnection(status)
      return 'OpenPencil canvas is visible. Its built-in MCP connection remains managed by StarWeave.'
    })
  }

  private hideCanvas(): Promise<string> {
    return this.enqueue(async () => {
      await desktopRequest<DesktopOpenPencilStatus>('/v1/openpencil/hide', { method: 'POST' })
      return 'OpenPencil canvas is hidden. Its MCP connection remains active in the background.'
    })
  }

  private async syncConnection(status: DesktopOpenPencilStatus): Promise<void> {
    await this.ctx.mcpSettings.setSystem({
      transport: 'streamable-http',
      serverName: MCP_SERVER_NAME,
      enabled: true,
      url: status.url ?? 'http://127.0.0.1:1/mcp',
      headers: status.token === undefined ? {} : { Authorization: `Bearer ${status.token}` },
      toolCallTimeoutMs: 120_000,
      failOnStartupError: false,
    })
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
      toolCount: countMcpTools(toolNames, MCP_SERVER_NAME),
    }
  }

  private phase(status: DesktopOpenPencilStatus): OpenPencilPhase {
    if (!status.running) return 'app-stopped'
    const phase = this.ctx.mcpSettings.systemPhase(MCP_SERVER_NAME)
    if (phase === 'active') return 'active'
    if (phase === 'failed') return 'failed'
    return 'connecting'
  }

  private async dropRuntime(): Promise<void> {
    await this.ctx.mcpSettings.removeSystem(MCP_SERVER_NAME)
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
