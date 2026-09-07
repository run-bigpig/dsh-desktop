import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { startDesignServer, type DesignServer } from './server.ts'
import type {} from '../workspace/index.ts'
import { WorkspaceDesignStore } from './workspace-store.ts'
import type { StoredDesignDocument } from './storage.ts'
import type { DesignConnection } from '../shared/types.ts'

const MCP_SERVER_NAME = 'starweave-design'
const DESIGN_POLICY = '这是 StarWeave 会话画布。首次启用时创建或恢复当前会话的设计。遵循 open_canvas 返回的 open-pencil 官方 Skill；历史设计会话可通过 skill 工具加载。然后必须调用 starweave-design MCP 服务器暴露的工具读取并修改当前已连接文档，不能只返回文字说明。禁止使用 Pwsh、bash 或其他 shell 调用 openpencil CLI。使用 open_canvas(path=工作区内.fig路径) 打开或创建文件；新设计使用独立路径并设置 newFile=true，继续编辑时复用原路径。成功修改自动保存到工作区并保留会话恢复快照。完成后必须调用 save_canvas，只有成功返回的文件才能向用户报告已保存；会话会展示可重新打开的文件卡片。不要调用 OpenPencil 原始文件生命周期工具。工具参数以当前 MCP schema 为准：简单图形使用 create_shape 和 set_fill；组合布局使用 render；复用工具返回的真实节点 ID，不要猜测 ID。编辑前按需使用 get_selection、get_node 或 get_page_tree 定位已有内容。选择、切页和视口操作使用 select_nodes、switch_page、viewport_zoom_to_fit，它们会同步到用户界面。变量和组件使用对应官方工具；图片填充使用 set_image_fill，参数为 image_data（PNG/JPEG/WebP 的 base64）和 scale_mode；共享样式使用 shared_style，create/update 从 node_id 读取属性，apply/detach 使用 node_ids，list 获取真实 style_id。修改既有矢量使用官方路径工具，不要创建替代图层。撤销或重做使用 undo、redo；导出使用 export_image、export_svg 或 export_pdf，不要把导出当作会话保存。若 MCP 提示尚未连接，等待画布初始化完成后重试。使用完成请求所需的最少工具；成功的修改已经生效，不要重复执行。完成修改后仅在确有必要时做一次轻量读取或渲染验证，确认目标存在后立即简洁回复并结束，不要在验证时创建替代对象。'

declare module '@deepseek-ai/cordis' {
  interface Context {
    starweaveDesign: StarWeaveDesignGateway
  }
}

export class StarWeaveDesignGateway extends TypertRemoteService {
  static inject = ['agentPresets', 'systemPrompt', 'tools', 'sessions', 'sessionPersistence', 'desktopWorkspace']

  private server: DesignServer | undefined
  private attachAgent: ((agent: Agent) => Promise<void>) | undefined
  private readonly stores = new Map<string, Promise<WorkspaceDesignStore>>()
  private readonly active = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'starweaveDesign')
  }

  protected async [Service.init](): Promise<void> {
    await syncDesignPreset()
    const authToken = randomBytes(32).toString('base64url')
    const server = await startDesignServer(authToken, undefined, sessionId => this.store(sessionId))
    this.server = server
    this.ctx.effect(() => this.ctx.root.on('api-session/removed', id => {
      this.active.delete(String(id))
    }), 'starweave-design: remove deleted session activation')
    const skill = await readFile(resolve(await findPresetSource(), 'skills/open-pencil/SKILL.md'), 'utf8')
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
    this.attachAgent = attach
    this.ctx.effect(() => this.ctx.tools.register(defineTool({
      name: 'open_canvas',
      description: '为当前会话打开设计画布，并启用 OpenPencil 工具。需要创建或编辑界面、图形、设计稿时调用；无需切换会话模式。',
      parameters: {
        path: { type: 'string', description: '当前工作区中的 .fig 文件路径；省略时恢复当前文件或创建独立设计文件' },
        newFile: { type: 'boolean', description: '创建独立的新设计，不覆盖现有文件' },
        presentation: { type: 'string', description: '展示步骤标识；同一步重复调用须复用，仅新展示步骤才更换' },
      },
      timeoutMs: 60_000,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('Canvas requires an owning agent session')
        await this.openFile(exec.agent, { ...(args.path ? { path: args.path } : {}), newFile: args.newFile === true }, exec.signal)
        const path = (await this.store(String(exec.agent.session.id))).currentBinding()?.path
        this.ctx.desktopWorkspace.request(exec.agent, 'canvas', undefined, path, args.presentation)
        return `当前会话画布已连接，可使用 starweave-design MCP 工具。\n${DESIGN_POLICY}\n\n${skill}`
      },
    })), 'starweave-design: activate session canvas')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({
      name: 'save_canvas',
      description: '完成设计后调用。等待当前画布成功保存到工作区，返回可在会话中重新打开的 .fig 文件卡片；保存不会重新打开已关闭的侧栏。',
      parameters: {},
      timeoutMs: 120_000,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (_args, exec) => {
        if (!exec.agent) throw new Error('Canvas requires an owning agent session')
        const id = String(exec.agent.session.id)
        return this.serial(id, async () => {
          await this.prepareCanvas(exec.agent!, exec.signal)
          await this.command(id, 'flush_document', {})
          return JSON.stringify((await this.store(id)).artifact())
        })
      },
    })), 'starweave-design: save workspace artifact')
    this.ctx.systemPrompt.section({
      name: 'starweave:design-session',
      order: 120,
      text: context => context.agent !== undefined
        && (this.active.has(String(context.agent.session.id)) || this.ctx.agentPresets.composedPreset(context.agent.ctx) === 'design')
        ? DESIGN_POLICY
        : ''
    })
    // The official agent-scoped MCP client preserves tool policy, projection,
    // cancellation and lifecycle while attaching trusted workspace identity.
    // Prompt providers are collected before agent/pre-step, so attach and
    // refresh the current assembly at the official prompt waterfall boundary.
    this.ctx.effect(() => this.ctx.root.on('system-prompt/assemble', async (assembly, context, next) => {
      const agent = context.agent
      if (agent === undefined || (!this.active.has(String(agent.session.id)) && this.ctx.agentPresets.composedPreset(agent.ctx) !== 'design')) return next()
      this.connection(String(agent.session.id))
      await attach(agent)
      assembly.tools = agent.ctx.tools.schemas(context.scope)
      return next()
    }), 'starweave-design: attach scoped MCP during design prompt assembly')
    this.ctx.effect(() => async () => {
      await this.server?.close()
      this.server = undefined
    }, 'starweave-design: dispose local server')
  }

  async canvasPath(sessionId: string): Promise<string | undefined> {
    return (await this.store(sessionId)).currentBinding()?.path
  }

  private store(sessionId: string): Promise<WorkspaceDesignStore> {
    let store = this.stores.get(sessionId)
    if (!store) {
      store = (async () => {
        const id = SessionId(sessionId)
        const header = this.ctx.sessions.get(id)?.header ?? (await this.ctx.sessionPersistence.inspect(id)).meta
        const location = this.ctx.sessionPersistence.locate(header)
        if (!location) throw new Error('当前会话的恢复目录不可用')
        return new WorkspaceDesignStore(resolve(header.cwd ?? process.cwd()), resolve(dirname(location.path), 'starweave-design.json'))
      })()
      this.stores.set(sessionId, store)
      void store.catch(() => { if (this.stores.get(sessionId) === store) this.stores.delete(sessionId) })
    }
    return store
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (!this.server) return Promise.reject(new Error('画布服务尚未就绪'))
    return this.server.exclusive(id, action)
  }

  private async command(id: string, command: string, args: unknown): Promise<void> {
    const response = await this.server!.sendRPC(id, command, args) as { ok?: boolean; error?: string }
    if (!response.ok) throw new Error(response.error ?? '画布操作失败')
  }

  @Remote('openFile')
  async openFile(agent: Agent, request: { path?: string; newFile?: boolean; reloadFromDisk?: boolean }, signal: AbortSignal): Promise<void> {
    const id = String(agent.session.id)
    await this.serial(id, async () => {
      const store = await this.store(id)
      const initialTarget = !this.active.has(id) && (request.path !== undefined || request.newFile === true)
      let initialDocument: StoredDesignDocument | undefined
      if (initialTarget) {
        await store.preserveRecovery()
        initialDocument = await store.select(request.path ?? `designs/design-${randomUUID().slice(0, 8)}.fig`, request.newFile === true)
      }
      await this.prepareCanvas(agent, signal)
      if (initialTarget) {
        await this.command(id, 'flush_document', { onlyDirty: true })
        if (initialDocument) await store.remember(initialDocument)
        return
      }
      const previous = store.currentBinding()
      if (!request.newFile && !request.path) return
      // Complete the old file before binding the editor to a different target.
      if (request.reloadFromDisk) await store.preserveRecovery()
      else await this.command(id, 'flush_document', { onlyDirty: true })
      signal.throwIfAborted()
      const path = request.path ?? `designs/design-${randomUUID().slice(0, 8)}.fig`
      const document = await store.select(path, request.newFile === true)
      try {
        await this.command(id, 'switch_document', { document, binding: store.currentBinding() })
      } catch (error) {
        if (previous) store.restoreBinding(previous)
        throw error
      }
      if (document) await store.remember(document)
      else await this.command(id, 'flush_document', {})
    })
  }

  async prepareCanvas(agent: Agent, signal: AbortSignal): Promise<void> {
    if (!this.server || !this.attachAgent) throw new Error('画布服务尚未就绪')
    this.connection(String(agent.session.id))
    await this.attachAgent(agent)
    await this.server.waitForReady(String(agent.session.id), signal)
    signal.throwIfAborted()
  }

  @Remote('connection')
  connection(sessionId: string): DesignConnection {
    if (!sessionId.trim()) throw new Error('Design session id is required')
    if (!this.server) throw new Error('StarWeave Design server is unavailable')
    this.active.add(sessionId)
    return this.server.connection(sessionId)
  }

  @Remote('activeConnections')
  activeConnections(): DesignConnection[] {
    return this.server ? [...this.active].map(id => this.server!.connection(id)) : []
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
