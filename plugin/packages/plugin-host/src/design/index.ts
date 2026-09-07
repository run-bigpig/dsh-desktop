import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { startDesignServer, type DesignServer } from './server.ts'
import type { DesignConnection } from '../shared/types.ts'

const MCP_SERVER_NAME = 'starweave-design'
const DESIGN_POLICY = '这是 StarWeave 设计模式。画布挂载后会自动创建空白设计。执行画布设计或编辑请求前，先调用 skill 工具加载 open-pencil 官方 Skill；若本轮已成功加载，不要重复加载。然后必须调用 starweave-design MCP 服务器暴露的工具读取并修改当前已连接文档，不能只返回文字说明。禁止使用 Pwsh、bash 或其他 shell 调用 openpencil CLI。打开文件和另存为 .fig 只能由用户在当前画布中操作；不要调用或请求文件生命周期工具。成功的画布修改会自动保存到当前 StarWeave 会话，并在应用重启后恢复。工具参数以当前 MCP schema 为准：简单图形使用 create_shape 和 set_fill；组合布局使用 render；复用工具返回的真实节点 ID，不要猜测 ID。编辑前按需使用 get_selection、get_node 或 get_page_tree 定位已有内容。选择、切页和视口操作使用 select_nodes、switch_page、viewport_zoom_to_fit，它们会同步到用户界面。变量和组件使用对应官方工具；图片填充使用 set_image_fill，参数为 image_data（PNG/JPEG/WebP 的 base64）和 scale_mode；共享样式使用 shared_style，create/update 从 node_id 读取属性，apply/detach 使用 node_ids，list 获取真实 style_id。修改既有矢量使用官方路径工具，不要创建替代图层。撤销或重做使用 undo、redo；导出使用 export_image、export_svg 或 export_pdf，不要把导出当作会话保存。若 MCP 提示尚未连接，等待画布初始化完成后重试。使用完成请求所需的最少工具；成功的修改已经生效，不要重复执行。完成修改后仅在确有必要时做一次轻量读取或渲染验证，确认目标存在后立即简洁回复并结束，不要在验证时创建替代对象。'

declare module '@deepseek-ai/cordis' {
  interface Context {
    starweaveDesign: StarWeaveDesignGateway
  }
}

export class StarWeaveDesignGateway extends TypertRemoteService {
  static inject = ['agentPresets', 'systemPrompt', 'tools', 'sessions', 'sessionPersistence']

  private server: DesignServer | undefined

  constructor(ctx: Context) {
    super(ctx, 'starweaveDesign')
  }

  protected async [Service.init](): Promise<void> {
    await syncDesignPreset()
    const authToken = randomBytes(32).toString('base64url')
    const server = await startDesignServer(authToken, async sessionId => {
      const id = SessionId(sessionId)
      // Browsing a persisted conversation does not publish a live Session.
      // Inspect through Harness so cold sessions retain its recovery boundaries.
      const header = this.ctx.sessions.get(id)?.header
        ?? (await this.ctx.sessionPersistence.inspect(id)).meta
      const location = this.ctx.sessionPersistence.locate(header)
      return location ? resolve(dirname(location.path), 'starweave-design.json') : undefined
    })
    this.server = server
    const clients = new Map<Agent, Promise<void>>()
    const attach = (agent: Agent): Promise<void> => {
      const existing = clients.get(agent)
      if (existing) return existing
      const owner = server.registerOwner({ id: agent.session.id })
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
      const ready = fiber.await().then(() => undefined).catch(async error => {
        clients.delete(agent)
        owner.dispose()
        await fiber.dispose()
        throw error
      })
      clients.set(agent, ready)
      return ready
    }
    this.ctx.systemPrompt.section({
      name: 'starweave:design-session',
      order: 120,
      text: context => context.agent !== undefined
        && this.ctx.agentPresets.composedPreset(context.agent.ctx) === 'design'
        ? DESIGN_POLICY
        : ''
    })
    // The official agent-scoped MCP client preserves tool policy, projection,
    // cancellation and lifecycle while attaching trusted workspace identity.
    // Prompt providers are collected before agent/pre-step, so attach and
    // refresh the current assembly at the official prompt waterfall boundary.
    this.ctx.effect(() => this.ctx.root.on('system-prompt/assemble', async (assembly, context, next) => {
      const agent = context.agent
      if (agent === undefined || this.ctx.agentPresets.composedPreset(agent.ctx) !== 'design') return next()
      await attach(agent)
      assembly.tools = agent.ctx.tools.schemas(context.scope)
      return next()
    }), 'starweave-design: attach scoped MCP during design prompt assembly')
    this.ctx.effect(() => async () => {
      await this.server?.close()
      this.server = undefined
    }, 'starweave-design: dispose local server')
  }

  @Remote('connection')
  connection(sessionId: string): DesignConnection {
    if (!sessionId.trim()) throw new Error('Design session id is required')
    if (!this.server) throw new Error('StarWeave Design server is unavailable')
    return this.server.connection(sessionId)
  }
}

const PRESET_FILES = ['agent.cordis.yml', 'preset.yml', 'skills/open-pencil/SKILL.md'] as const

async function syncDesignPreset(): Promise<void> {
  const harnessHome = process.env.DSH_HOME?.trim()
  if (!harnessHome) throw new Error('StarWeave Design requires DSH_HOME')
  const source = await findPresetSource()
  const target = resolve(harnessHome, '.starweave-agent-presets/design')
  for (const relative of PRESET_FILES) {
    const content = await readFile(resolve(source, relative))
    const filename = resolve(target, relative)
    await mkdir(dirname(filename), { recursive: true })
    await writeFile(filename, content)
  }
}

async function findPresetSource(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL('../presets/design/', import.meta.url)),
    fileURLToPath(new URL('../../presets/design/', import.meta.url))
  ]
  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, 'agent.cordis.yml'))
      return candidate
    } catch { continue }
  }
  throw new Error('StarWeave Design preset is missing')
}

export default StarWeaveDesignGateway
