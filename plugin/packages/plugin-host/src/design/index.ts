import { randomBytes } from 'node:crypto'

import { Context, Service } from '@deepseek-ai/cordis'

import { startDesignServer, type DesignServer } from './server.ts'
import { registerStarWeaveDesignSkill } from './skill.ts'

const MCP_SERVER_NAME = 'starweave-design'

declare module '@deepseek-ai/cordis' {
  interface Context {
    starweaveDesign: StarWeaveDesignGateway
  }
}

export class StarWeaveDesignGateway extends Service {
  static inject = ['mcpSettings', 'skills']

  private server: DesignServer | undefined
  private disposeSkill: (() => void) | undefined

  constructor(ctx: Context) {
    super(ctx, 'starweaveDesign')
  }

  protected async [Service.init](): Promise<void> {
    const authToken = randomBytes(32).toString('base64url')
    const server = await startDesignServer(authToken)
    this.server = server
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
      text: '创建或修改界面、根据截图或线框图生成设计时，使用 $starweave-design 和 starweave-design MCP；先打开独立画布并持续复用 design_session_id。'
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
