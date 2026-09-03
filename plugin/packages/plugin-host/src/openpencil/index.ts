import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MCP_VERSION, startServer, type ServerHandle } from '@open-pencil/mcp'
import { countMcpTools } from '../mcp/document.ts'
import type {
  OpenPencilClientConnection,
  OpenPencilCollaborationHostSession,
  OpenPencilDesignFile,
  OpenPencilDesignWriteRequest,
  OpenPencilPhase,
  OpenPencilSnapshot,
} from '../shared/types.ts'
import {
  readWorkspaceBinaryFile,
  workspaceRoot,
  writeWorkspaceBinaryFile,
} from '../workspace/index.ts'
import { defineOpenPencilControlTools } from './control-tools.ts'
import {
  startOpenPencilLanCollaborationServer,
  type OpenPencilLanCollaborationServer,
} from './collaboration.ts'
import { registerOpenPencilSkill } from './skill.ts'

const MCP_SERVER_NAME = 'openpencil-mcp'
const require = createRequire(import.meta.url)
const BUNDLED_FONT_FILES = new Map([
  ['Inter|Regular', 'Inter-Regular.ttf'],
  ['Inter|Medium', 'Inter-Medium.ttf'],
  ['Inter|SemiBold', 'Inter-SemiBold.ttf'],
  ['Inter|Bold', 'Inter-Bold.ttf'],
  ['Inter|ExtraBold', 'Inter-ExtraBold.ttf'],
  ['Noto Naskh Arabic|Regular', 'NotoNaskhArabic-Regular.ttf'],
])

export class OpenPencilGateway extends TypertRemoteService {
  static inject = ['tools', 'skills', 'mcpSettings']

  private readonly authToken = randomBytes(32).toString('hex')
  private disposeSkill: (() => void) | undefined
  private server: ServerHandle | undefined
  private visible = false
  private revision = 0
  private canvasKitBase64: string | undefined
  private readonly fontBase64 = new Map<string, string>()
  private mcpRegistered = false
  private collaboration: OpenPencilLanCollaborationServer | undefined

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
    await this.startRuntime()
    this.ctx.effect(() => async () => this.dropRuntime(), 'openpencil: dispose runtime')
  }

  @Remote('snapshot')
  snapshot(): Promise<OpenPencilSnapshot> {
    return Promise.resolve(this.currentSnapshot())
  }

  @Remote('show')
  show(): Promise<OpenPencilSnapshot> {
    this.setVisible(true)
    return Promise.resolve(this.currentSnapshot())
  }

  @Remote('hide')
  hide(): Promise<OpenPencilSnapshot> {
    this.setVisible(false)
    return Promise.resolve(this.currentSnapshot())
  }

  @Remote('connection')
  connection(): Promise<OpenPencilClientConnection> {
    if (this.server === undefined || this.server.httpPort < 1) {
      throw new Error('openpencil: MCP runtime is not ready')
    }
    return Promise.resolve({
      port: this.server.httpPort,
      authToken: this.authToken,
      version: MCP_VERSION,
    })
  }

  @Remote('canvasKitWasm')
  async canvasKitWasm(): Promise<string> {
    if (this.canvasKitBase64 !== undefined) return this.canvasKitBase64
    const packagePath = require.resolve('canvaskit-wasm/package.json')
    const wasmPath = resolve(dirname(packagePath), 'bin', 'canvaskit.wasm')
    this.canvasKitBase64 = (await readFile(wasmPath)).toString('base64')
    return this.canvasKitBase64
  }

  @Remote('fontAsset')
  async fontAsset(family: string, style: string): Promise<string | null> {
    const key = `${family}|${style}`
    const filename = BUNDLED_FONT_FILES.get(key)
    if (filename === undefined) return null
    const cached = this.fontBase64.get(key)
    if (cached !== undefined) return cached
    const packagePath = require.resolve('@open-pencil/core/package.json')
    const fontPath = resolve(dirname(packagePath), 'assets', filename)
    const encoded = (await readFile(fontPath)).toString('base64')
    this.fontBase64.set(key, encoded)
    return encoded
  }

  @Remote('startCollaboration')
  async startCollaboration(): Promise<OpenPencilCollaborationHostSession> {
    const previous = this.collaboration
    this.collaboration = undefined
    await previous?.close()
    const collaboration = await startOpenPencilLanCollaborationServer()
    this.collaboration = collaboration
    return collaboration.session
  }

  @Remote('stopCollaboration')
  async stopCollaboration(hostKey: string): Promise<void> {
    if (this.collaboration === undefined || this.collaboration.session.hostKey !== hostKey) return
    const collaboration = this.collaboration
    this.collaboration = undefined
    await collaboration.close()
  }

  @Remote('readDesignFile')
  async readDesignFile(agent: Agent, path: string, signal: AbortSignal): Promise<OpenPencilDesignFile> {
    const result = await readWorkspaceBinaryFile(workspaceRoot(agent), path, signal)
    return { path: result.path, dataBase64: Buffer.from(result.data).toString('base64') }
  }

  @Remote('writeDesignFile')
  async writeDesignFile(
    agent: Agent,
    request: OpenPencilDesignWriteRequest,
    signal: AbortSignal,
  ): Promise<{ readonly path: string }> {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(request.dataBase64)) {
      throw new Error('openpencil: design payload is not valid base64')
    }
    const data = Buffer.from(request.dataBase64, 'base64')
    return await writeWorkspaceBinaryFile(workspaceRoot(agent), request.path, data, signal)
  }

  private async startRuntime(): Promise<void> {
    const server = await startEmbeddedOpenPencilServer(this.authToken, process.cwd())
    try {
      await this.ctx.mcpSettings.setSystem({
        transport: 'streamable-http',
        serverName: MCP_SERVER_NAME,
        enabled: true,
        url: `http://127.0.0.1:${server.httpPort}/mcp`,
        headers: { Authorization: `Bearer ${this.authToken}` },
        toolCallTimeoutMs: 120_000,
        failOnStartupError: false,
      })
    } catch (error) {
      await server.close()
      throw error
    }
    this.server = server
    this.mcpRegistered = true
  }

  private currentSnapshot(): OpenPencilSnapshot {
    const running = this.server !== undefined && this.server.httpPort > 0
    const phase = this.phase(running)
    const toolNames = this.ctx.tools.schemas().map(schema => schema.name)
    return {
      bundled: true,
      running,
      owned: running,
      port: this.server?.httpPort ?? null,
      phase,
      mcpConnected: phase === 'active',
      toolCount: countMcpTools(toolNames, MCP_SERVER_NAME),
      visible: this.visible,
      revision: this.revision,
    }
  }

  private phase(running: boolean): OpenPencilPhase {
    if (!running) return 'app-stopped'
    const phase = this.ctx.mcpSettings.systemPhase(MCP_SERVER_NAME)
    if (phase === 'active') return 'active'
    if (phase === 'failed') return 'failed'
    return 'connecting'
  }

  private setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.revision += 1
  }

  private async showCanvas(): Promise<string> {
    this.setVisible(true)
    return 'OpenPencil canvas is visible inside StarWeave. Its built-in MCP connection remains active.'
  }

  private async hideCanvas(): Promise<string> {
    this.setVisible(false)
    return 'OpenPencil canvas is hidden. Its built-in MCP connection remains active.'
  }

  private async dropRuntime(): Promise<void> {
    const server = this.server
    const mcpRegistered = this.mcpRegistered
    this.server = undefined
    this.mcpRegistered = false
    const collaboration = this.collaboration
    this.collaboration = undefined
    try {
      if (mcpRegistered) await this.ctx.mcpSettings.removeSystem(MCP_SERVER_NAME)
    } finally {
      await collaboration?.close()
      await server?.close()
      this.disposeSkill?.()
      this.disposeSkill = undefined
    }
  }
}

export function startEmbeddedOpenPencilServer(authToken: string, mcpRoot: string): Promise<ServerHandle> {
  return startServer({
    httpPort: 0,
    withTcp: true,
    socketPath: null,
    authToken,
    mcpRoot,
    enableEval: false,
  })
}

export default OpenPencilGateway
