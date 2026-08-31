import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context, Service, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ThinkingDataConnectionPhase,
  ThinkingDataSaveRequest,
  ThinkingDataSnapshot,
  ThinkingDataTestRequest,
  ThinkingDataTestResult,
} from '../shared/types.ts'
import {
  effectiveThinkingDataUrl,
  emptyThinkingDataDocument,
  parseThinkingDataDocument,
  serializeThinkingDataDocument,
  THINKINGDATA_CREDENTIAL_REF,
  THINKINGDATA_SERVER_NAME,
  THINKINGDATA_TOOL_TIMEOUT_MS,
  validateThinkingDataUrl,
  type ThinkingDataDocument,
} from './document.ts'
import { registerThinkingDataSkill } from './skill.ts'

export interface ThinkingDataConfig {
  readonly path: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    thinkingData: ThinkingDataGateway
  }
}

const TOKEN_REF = credentialRef(THINKINGDATA_CREDENTIAL_REF)
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const
const FIBER_PHASE: Record<FiberState, ThinkingDataConnectionPhase> = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: 'disabled',
  [FIBER_STATE.UNLOADING]: 'unloading',
}

export class ThinkingDataGateway extends TypertRemoteService {
  static inject = ['tools', 'credentials', 'skills']
  static Config: z<ThinkingDataConfig> = z.object({ path: z.string().required() })

  private readonly filename: string
  private document: ThinkingDataDocument = emptyThinkingDataDocument()
  private fiber: Fiber | undefined
  private disposeSkill: (() => void) | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: ThinkingDataConfig) {
    super(ctx, 'thinkingData')
    this.filename = resolve(config.path)
  }

  protected async [Service.init](): Promise<void> {
    this.document = await this.readDocument()
    await this.syncConnection()
    this.ctx.effect(() => () => this.dropRuntime(), 'thinkingdata: dispose runtime')
  }

  @Remote('snapshot')
  snapshot(): Promise<ThinkingDataSnapshot> {
    return this.enqueue(async () => {
      const tokenConfigured = (await this.ctx.credentials.describe(TOKEN_REF)).configured
      return {
        enabled: this.document.enabled,
        url: this.document.url,
        effectiveUrl: effectiveThinkingDataUrl(this.document.url),
        tokenConfigured,
        phase: this.phase(tokenConfigured),
      }
    })
  }

  @Remote('save')
  save(request: ThinkingDataSaveRequest): Promise<{ readonly ok: true }> {
    return this.enqueue(async () => {
      if (typeof request.enabled !== 'boolean' || typeof request.url !== 'string') {
        throw new Error('thinkingdata: invalid settings request')
      }
      validateThinkingDataUrl(request.url)
      const token = request.token?.trim()
      if (token !== undefined && token.length > 0) await this.ctx.credentials.set(TOKEN_REF, token)
      const next = { version: 1 as const, enabled: request.enabled, url: request.url.trim() }
      await this.persist(next)
      this.document = next
      await this.syncConnection()
      return { ok: true }
    })
  }

  @Remote('testConnection')
  testConnection(request: ThinkingDataTestRequest): Promise<ThinkingDataTestResult> {
    return this.enqueue(async () => {
      if (typeof request.url !== 'string') throw new Error('thinkingdata: invalid test request')
      validateThinkingDataUrl(request.url)
      const supplied = request.token?.trim()
      const token = supplied || (await this.ctx.credentials.resolve(TOKEN_REF))?.value
      if (token === undefined || token.length === 0) return { ok: false, status: 'missing-token' }
      return await probeThinkingData(effectiveThinkingDataUrl(request.url), token)
    })
  }

  private phase(tokenConfigured: boolean): ThinkingDataConnectionPhase {
    if (!this.document.enabled) return 'disabled'
    if (!tokenConfigured) return 'missing-token'
    if (this.fiber === undefined) return 'pending'
    const phase = FIBER_PHASE[this.fiber.state]
    return phase === 'active' && !this.hasTools() ? 'failed' : phase
  }

  private async syncConnection(): Promise<void> {
    await this.dropRuntime()
    if (!this.document.enabled) return
    const token = (await this.ctx.credentials.resolve(TOKEN_REF))?.value
    if (token === undefined || token.length === 0) return
    this.disposeSkill = await registerThinkingDataSkill(this.ctx)
    this.fiber = this.ctx.plugin({
      name: mcpClient.name,
      inject: mcpClient.inject,
      Config: mcpClient.Config,
      apply: mcpClient.apply,
    }, {
      transport: 'streamable-http',
      serverName: THINKINGDATA_SERVER_NAME,
      url: effectiveThinkingDataUrl(this.document.url),
      headers: { Authorization: `Bearer ${token}` },
      toolCallTimeoutMs: THINKINGDATA_TOOL_TIMEOUT_MS,
      failOnStartupError: false,
    })
    void Promise.resolve(this.fiber).catch((error: unknown) => { this.ctx.logger.warn(error) })
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

  private async readDocument(): Promise<ThinkingDataDocument> {
    try {
      return parseThinkingDataDocument(await readFile(this.filename, 'utf8'))
    } catch (error) {
      if (isEnoent(error)) return emptyThinkingDataDocument()
      throw error
    }
  }

  private hasTools(): boolean {
    const prefix = `mcp__${THINKINGDATA_SERVER_NAME}__`
    return this.ctx.tools.schemas().some(schema => schema.name.startsWith(prefix))
  }

  private async persist(document: ThinkingDataDocument): Promise<void> {
    await writeFileAtomic(this.filename, serializeThinkingDataDocument(document), { mode: 0o600, dirMode: 0o700 })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

async function probeThinkingData(url: string, token: string): Promise<ThinkingDataTestResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'StarWeave', version: '1' } },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      return { ok: false, status: 'unauthorized' }
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { ok: false, status: 'unreachable' }
    }
    if (!isInitializeResponse(await response.text())) return { ok: false, status: 'unreachable' }
    const readyUrl = new URL(url)
    readyUrl.pathname = '/readyz'
    readyUrl.search = ''
    readyUrl.hash = ''
    const ready = await fetch(readyUrl, { signal: AbortSignal.timeout(10_000) })
    if (ready.status === 503) return { ok: false, status: 'not-ready' }
    if (!ready.ok) return { ok: true, status: 'connected' }
    return { ok: true, status: 'ready' }
  } catch {
    return { ok: false, status: 'unreachable' }
  }
}

function isInitializeResponse(body: string): boolean {
  const payload = body.startsWith('data:')
    ? body.split('\n').find(line => line.startsWith('data:'))?.slice(5).trim()
    : body
  if (payload === undefined || payload.length === 0) return false
  try {
    const value = JSON.parse(payload) as unknown
    return typeof value === 'object' && value !== null && 'result' in value
  } catch {
    return false
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export default ThinkingDataGateway
