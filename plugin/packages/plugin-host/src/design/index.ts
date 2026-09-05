import { randomBytes } from 'node:crypto'

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

import { startDesignServer, type DesignServer } from './server.ts'
import { registerStarWeaveDesignSkill } from './skill.ts'

const MCP_SERVER_NAME = 'starweave-design'

declare module '@deepseek-ai/cordis' {
  interface Context {
    starweaveDesign: StarWeaveDesignGateway
  }
}

export class StarWeaveDesignGateway extends Service {
  static inject = ['mcpSettings', 'skills', 'tools']

  private server: DesignServer | undefined
  private disposeSkill: (() => void) | undefined

  constructor(ctx: Context) {
    super(ctx, 'starweaveDesign')
  }

  protected async [Service.init](): Promise<void> {
    const authToken = randomBytes(32).toString('base64url')
    const server = await startDesignServer(authToken)
    this.server = server
    const clients = new Map<Agent, Promise<void>>()
    const attach = (agent: Agent): Promise<void> => {
      const existing = clients.get(agent)
      if (existing) return existing
      const owner = server.registerOwner({ id: agent.id, workspace: () => agent.session.header.cwd })
      const fiber = agent.ctx.plugin({
        name: mcpClient.name,
        inject: mcpClient.inject,
        Config: mcpClient.Config,
        apply: mcpClient.apply
      }, {
        transport: 'streamable-http', serverName: MCP_SERVER_NAME,
        url: `http://127.0.0.1:${server.port}/mcp`,
        headers: { Authorization: `Bearer ${authToken}`, 'x-starweave-owner': owner.token },
        toolCallTimeoutMs: 120_000, failOnStartupError: true
      })
      this.ctx.effect(() => () => fiber.dispose(), 'starweave-design: dispose scoped MCP')
      agent.ctx.effect(() => () => { owner.dispose(); clients.delete(agent) }, 'starweave-design: revoke owner')
      const ready = Promise.resolve(fiber).then(() => undefined).catch(async error => {
        clients.delete(agent)
        owner.dispose()
        await fiber.dispose()
        throw error
      })
      clients.set(agent, ready)
      return ready
    }
    // The official agent-scoped MCP client preserves tool policy, projection,
    // cancellation and lifecycle while attaching trusted workspace identity.
    this.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (this.ctx.mcpSettings.systemPhase(MCP_SERVER_NAME) === 'active') {
        await attach(agent).catch(error => this.ctx.logger.warn('Unable to initialize workspace design tools', error))
      }
      return next()
    })
    this.ctx.tools.guard(exec => {
      if (exec.name.startsWith(`mcp__${MCP_SERVER_NAME}__`) && this.ctx.mcpSettings.systemPhase(MCP_SERVER_NAME) !== 'active') {
        return 'StarWeave Design MCP is disabled or unavailable'
      }
      return undefined
    })
    try {
      await this.ctx.mcpSettings.setSystem({
        transport: 'streamable-http',
        serverName: MCP_SERVER_NAME,
        url: `http://127.0.0.1:${server.port}/mcp`,
        headers: { Authorization: `Bearer ${authToken}` },
        enabled: true,
        toolCallTimeoutMs: 120_000,
        failOnStartupError: true
      })
      this.disposeSkill = await registerStarWeaveDesignSkill(this.ctx)
    } catch (error) {
      this.disposeSkill?.()
      this.disposeSkill = undefined
      await Promise.allSettled([
        this.ctx.mcpSettings.removeSystem(MCP_SERVER_NAME),
        server.close()
      ])
      this.server = undefined
      throw error
    }
    this.ctx.get('systemPrompt')?.section({
      name: 'starweave:design',
      order: 120,
      text: '创建或修改界面、根据截图或线框图生成设计时，使用 $starweave-design 和 starweave-design MCP；先调用 open_design_workspace 打开独立画布，后续官方 OpenPencil 工具会自动操作该画布。'
    })
    this.ctx.effect(() => async () => {
      this.disposeSkill?.()
      this.disposeSkill = undefined
      await this.ctx.mcpSettings.removeSystem(MCP_SERVER_NAME)
      await this.server?.close()
      this.server = undefined
    }, 'starweave-design: dispose local server')
  }
}

export default StarWeaveDesignGateway
