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
      text: '需要进行界面或视觉设计时，使用 starweave-design MCP 工具。不要先创建任务列表、检查清单或在画布外一次性规划后批量执行；立即调用 open_design_workspace 打开 StarWeave Design 独立画布窗口，并在整个设计过程中持续复用返回的 design_session_id。打开画布后以用户可观察的节奏实时编辑：每次只执行一个可见的小步骤，例如创建一个 frame、section、component 或完成一次局部修改；等待当前 MCP 调用返回后再继续下一步，禁止并行发起会修改画布的工具调用。每一步都应选择或定位当前编辑目标，让用户持续看到 Agent 正在编辑的位置。大型界面必须按 frame、section、component 逐步构建，直到设计完成。'
    })
    this.ctx.effect(() => async () => {
      await this.ctx.mcpSettings.removeSystem(MCP_SERVER_NAME)
      await this.server?.close()
      this.server = undefined
    }, 'starweave-design: dispose local server')
  }
}

export default StarWeaveDesignGateway
