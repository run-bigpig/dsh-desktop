import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { startDesignServer, type DesignServer } from './server.ts'
import type { DesignConnection } from '../shared/types.ts'

const MCP_SERVER_NAME = 'starweave-design'

declare module '@deepseek-ai/cordis' {
  interface Context {
    starweaveDesign: StarWeaveDesignGateway
  }
}

export class StarWeaveDesignGateway extends TypertRemoteService {
  private server: DesignServer | undefined

  constructor(ctx: Context) {
    super(ctx, 'starweaveDesign')
  }

  protected async [Service.init](): Promise<void> {
    await syncDesignPreset()
    const authToken = randomBytes(32).toString('base64url')
    const server = await startDesignServer(authToken)
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
      const systemPrompt = agent.ctx.get('systemPrompt')
      if (systemPrompt !== undefined) {
        agent.ctx.effect(() => systemPrompt.section({
          name: 'starweave:design-session',
          order: 120,
          text: '这是设计模式。文档只能由用户在当前画布中创建、打开和保存。不要调用或请求文件生命周期工具；只使用 OpenPencil MCP 操作当前已连接文档。若工具提示尚未连接，请让用户先在画布中创建或打开文档。'
        }), 'starweave-design: scoped design policy')
      }
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
      if (agent.session.header.agentPreset === 'design') {
        await attach(agent).catch(error => this.ctx.logger.warn('Unable to initialize workspace design tools', error))
      }
      return next()
    })
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
