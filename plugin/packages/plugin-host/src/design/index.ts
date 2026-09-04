import { randomBytes } from 'node:crypto'

import { Context, Service } from '@deepseek-ai/cordis'

import { startDesignServer, type DesignServer } from './server.ts'

const MCP_SERVER_NAME = 'starweave-design'

declare module '@deepseek-ai/cordis' {
  interface Context {
    starweaveDesign: StarWeaveDesignGateway
  }
}

export class StarWeaveDesignGateway extends Service {
  static inject = ['mcpSettings']

  private server: DesignServer | undefined

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
    } catch (error) {
      await server.close()
      this.server = undefined
      throw error
    }
    this.ctx.get('systemPrompt')?.section({
      name: 'starweave:design',
      order: 120,
      text: '需要进行界面或视觉设计时，使用 starweave-design MCP 工具。首次调用会通过系统浏览器打开 StarWeave Design；持续在同一任务中复用返回的 design_session_id。'
    })
    this.ctx.effect(() => async () => {
      await this.ctx.mcpSettings.removeSystem(MCP_SERVER_NAME)
      await this.server?.close()
      this.server = undefined
    }, 'starweave-design: dispose local server')
  }
}

export default StarWeaveDesignGateway
