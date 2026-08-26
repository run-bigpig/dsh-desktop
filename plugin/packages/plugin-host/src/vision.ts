import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentId, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { captionImage, testVisionConnection, type VisionClientConfig } from './vision-caption.ts'
import {
  emptyVisionBridgeDocument,
  isTargetEnabled,
  mergeVision,
  parseVisionBridgeDocument,
  serializeVisionBridgeDocument,
  visionModelReady,
  type VisionBridgeDocument,
  type VisionModelSelectionRecord,
  type VisionTargetRecord,
} from './vision-document.ts'
import {
  allImagesCaptioned,
  hasLookAtToolSinceLastUser,
  LOOK_AT_REASONING,
  messagesHaveImage,
  normalizeLookAtReplayState,
  rewriteOptions,
  stripLookAtTool,
  uniqueRequestImages,
} from './vision-rewrite.ts'
import { defineLookAtImageTool, lookAtArgFromImage, LOOK_AT_TOOL_NAME, type LookAtImageArg } from './vision-tool.ts'
import type {
  VisionBridgeMutationResult,
  VisionBridgeSnapshot,
  VisionCatalogGroup,
  VisionSaveRequest,
  VisionTestRequest,
  VisionTestResult,
} from './types.ts'

export interface VisionBridgeConfig {
  readonly path: string
}

type ResolveModelInfo = (
  provider: string,
  model: string,
  signal?: AbortSignal,
) => Promise<LlmResolvedModelInfo>

export class VisionBridgeGateway extends TypertRemoteService {
  static inject = ['llm', 'attachments', 'tools', 'settings', 'credentials']
  static Config: z<VisionBridgeConfig> = z.object({ path: z.string().required() })

  private readonly filename: string
  private document: VisionBridgeDocument = emptyVisionBridgeDocument()
  private chain: Promise<void> = Promise.resolve()
  private readonly captions = new Map<string, string>()
  private originalResolve: ResolveModelInfo | undefined

  constructor(ctx: Context, config: VisionBridgeConfig) {
    super(ctx, 'visionBridge')
    this.filename = resolve(config.path)
  }

  protected async [Service.init](): Promise<void> {
    this.document = await this.readDocument()
    this.installCapabilityClaim()
    this.installLookAtTool()
    this.ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => (
      this.onStream(options, next)
    ))
    this.ctx.on('llm/adapters-updated', () => { this.captions.clear() })
    const systemPrompt = this.ctx.get('systemPrompt')
    systemPrompt?.section({
      name: 'desktop-vision-bridge',
      order: 80,
      text: [
        'Images appear as [Image: filename] text blocks after the 识图 (look_at_image) tool runs.',
        'Treat those blocks as complete descriptions of the user attachments.',
        'Do not call look_at_image yourself, announce image review, or restate the [Image] blocks.',
        'Answer the user directly and keep normal reasoning in the reasoning channel.',
      ].join(' '),
    })
  }

  @Remote('snapshot')
  snapshot(): Promise<VisionBridgeSnapshot> {
    return this.enqueue(() => this.projectSnapshot())
  }

  @Remote('save')
  save(request: VisionSaveRequest): Promise<VisionBridgeMutationResult> {
    return this.enqueue(async () => {
      const vision = request.vision === undefined
        ? this.document.vision
        : mergeVision(request.vision)
      await this.validateSelection(vision)
      const targets = request.targets === undefined ? this.document.targets : normalizeTargets(request.targets)
      this.document = { ...this.document, version: 2, vision, targets }
      await this.persist()
      return { ok: true }
    })
  }

  @Remote('testConnection')
  testConnection(request: VisionTestRequest): Promise<VisionTestResult> {
    return this.enqueue(async () => {
      const config = mergeVision(request)
      try {
        await this.validateSelection(config)
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      }
      return testVisionConnection(this.ctx.llm, config)
    })
  }

  private installLookAtTool(): void {
    this.ctx.effect(
      () => this.ctx.tools.register(defineLookAtImageTool((images, signal) => this.captionRefs(images, signal))),
      'desktop-vision: look_at_image tool',
    )
    this.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === LOOK_AT_TOOL_NAME) return { kind: 'allow' }
      return next()
    })
  }

  private installCapabilityClaim(): void {
    const llm = this.ctx.llm
    const original = llm.resolveModelInfo.bind(llm)
    this.originalResolve = original
    const patched: ResolveModelInfo = async (provider, model, signal) => {
      const info = await original(provider, model, signal)
      if (!this.shouldClaim(provider, model) || info.inputModalities?.includes('image') === true) return info
      return { ...info, inputModalities: [...new Set([...(info.inputModalities ?? ['text']), 'text', 'image'] as const)] }
    }
    llm.resolveModelInfo = patched
    this.ctx.effect(() => () => {
      if (llm.resolveModelInfo === patched) llm.resolveModelInfo = original
    }, 'desktop-vision: restore resolveModelInfo')
  }

  private shouldClaim(provider: string, model: string): boolean {
    return visionModelReady(this.document.vision) && isTargetEnabled(this.document.targets, provider, model)
  }

  private async isNativeVision(provider: string, model: string, signal?: AbortSignal): Promise<boolean> {
    const resolveInfo = this.originalResolve ?? this.ctx.llm.resolveModelInfo.bind(this.ctx.llm)
    try {
      return (await resolveInfo(provider, model, signal)).inputModalities?.includes('image') === true
    } catch {
      return false
    }
  }

  private async shouldWrap(options: GenerateOptions): Promise<boolean> {
    return this.shouldClaim(options.provider, options.model)
      && messagesHaveImage(options.messages)
      && !(await this.isNativeVision(options.provider, options.model, options.signal))
  }

  private async *onStream(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const sanitized = normalizeLookAtReplayState(options, LOOK_AT_TOOL_NAME)
    if (!(await this.shouldWrap(sanitized))) {
      if (sanitized === options) yield* next()
      else yield* this.ctx.llm.stream(sanitized)
      return
    }
    if (sanitized.purpose === 'compaction' || sanitized.purpose === 'session-title') {
      yield* this.ctx.llm.stream(await this.captionAndRewrite(sanitized))
      return
    }
    const alreadyCalled = hasLookAtToolSinceLastUser(sanitized.messages, LOOK_AT_TOOL_NAME)
    const cached = allImagesCaptioned(sanitized.messages, this.captions)
    if (!alreadyCalled && !cached) {
      yield* this.emitLookAtCall(sanitized)
      return
    }
    if (!cached) {
      const text = '识图超时或失败，请再发一次图片。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield* this.ctx.llm.stream(stripLookAtTool(await this.captionAndRewrite(sanitized), LOOK_AT_TOOL_NAME))
  }

  private async *emitLookAtCall(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const args = JSON.stringify({ images: uniqueRequestImages(options.messages).map(lookAtArgFromImage) })
    const id = CallId(randomUUID())
    yield* syntheticLookAtCallChunks(id, args)
  }

  private visionConfig(): VisionClientConfig {
    if (!visionModelReady(this.document.vision)) {
      throw new Error('vision-bridge: select a Harness vision model before sending images')
    }
    return this.document.vision
  }

  private async captionRefs(
    images: readonly LookAtImageArg[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    const captions = new Map<string, string>()
    const config = this.visionConfig()
    await Promise.all(images.map(async image => {
      const cached = this.captions.get(image.attachmentId)
      if (cached !== undefined) {
        captions.set(image.attachmentId, cached)
        return
      }
      const stored = await this.ctx.attachments.readImage({
        attachmentId: AttachmentId(image.attachmentId),
        mediaType: imageMediaType(image.mediaType),
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(image.name === undefined ? {} : { name: image.name }),
      }, signal)
      const caption = await captionImage(this.ctx.llm, config, stored.ref, signal)
      this.captions.set(image.attachmentId, caption)
      captions.set(image.attachmentId, caption)
    }))
    return captions
  }

  private async captionAndRewrite(options: GenerateOptions): Promise<GenerateOptions> {
    const images = uniqueRequestImages(options.messages).map(lookAtArgFromImage)
    return rewriteOptions(options, await this.captionRefs(images, options.signal))
  }

  private async projectSnapshot(): Promise<VisionBridgeSnapshot> {
    return {
      vision: {
        provider: this.document.vision.provider,
        model: this.document.vision.model,
      },
      ...this.document.legacyVision === undefined ? {} : {
        legacyVision: {
          baseURL: this.document.legacyVision.baseURL,
          model: this.document.legacyVision.model,
          hasApiKey: this.document.legacyVision.apiKey.trim().length > 0,
        },
      },
      targets: this.document.targets.map(target => ({ ...target })),
      catalog: await this.listCatalog(),
    }
  }

  private async validateSelection(selection: VisionModelSelectionRecord): Promise<void> {
    if (!visionModelReady(selection)) {
      if (selection.provider.length === 0 && selection.model.length === 0) return
      throw new Error('vision-bridge: both provider and model are required')
    }
    const provider = this.ctx.llm.listProviders().find(entry => entry.id === selection.provider)
    if (provider === undefined) {
      throw new Error(`vision-bridge: Harness provider ${JSON.stringify(selection.provider)} is not active`)
    }
    if (!(await this.isProviderUsable(selection.provider))) {
      throw new Error(`vision-bridge: Harness provider ${JSON.stringify(selection.provider)} is not fully configured`)
    }
    const models = await this.ctx.llm.listModels(selection.provider)
    if (!models.some(model => model.id === selection.model)) {
      throw new Error(`vision-bridge: model ${JSON.stringify(selection.model)} is not listed by the Harness provider`)
    }
  }

  private async listCatalog(): Promise<VisionCatalogGroup[]> {
    const groups: VisionCatalogGroup[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      try {
        if (!(await this.isProviderUsable(provider.id))) continue
        const models = await this.ctx.llm.listModels(provider.id)
        const resolvedModels = await Promise.all(models.map(async model => {
          try {
            return await this.ctx.llm.resolveModelInfo(provider.id, model.id)
          } catch (error) {
            this.ctx.logger.warn(`desktop-vision: failed to resolve ${provider.id}/${model.id}: ${String(error)}`)
            return model
          }
        }))
        groups.push({
          provider: provider.id,
          providerName: provider.name,
          models: resolvedModels.map(model => ({
            id: model.id,
            name: model.name,
            nativeVision: model.inputModalities?.includes('image') === true,
          })),
        })
      } catch (error) {
        this.ctx.logger.warn(`desktop-vision: failed to list models for ${provider.id}: ${String(error)}`)
      }
    }
    return groups
  }

  private async isProviderUsable(provider: string): Promise<boolean> {
    const directory = this.ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)
    if (directory === undefined) return true
    const section = this.ctx.settings.get(settingsNamespace(directory.settingsNs))
    const profile = valueAtPath(section, directory.settingsPath)
    if (!isRecord(profile)) return false
    const ref = profile.apiKeyEnv
    if (ref === undefined) return true
    if (typeof ref !== 'string' || ref.length === 0) return false
    return (await this.ctx.credentials.describe(credentialRef(ref))).configured
  }

  private async readDocument(): Promise<VisionBridgeDocument> {
    try {
      return parseVisionBridgeDocument(await readFile(this.filename, 'utf8'))
    } catch (error) {
      if (isEnoent(error)) return emptyVisionBridgeDocument()
      throw error
    }
  }

  private async persist(): Promise<void> {
    await writeFileAtomic(this.filename, serializeVisionBridgeDocument(this.document), {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

export function syntheticLookAtCallChunks(id: ReturnType<typeof CallId>, args: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: LOOK_AT_REASONING },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: LOOK_AT_REASONING } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id, name: LOOK_AT_TOOL_NAME, argumentsDelta: args },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: LOOK_AT_TOOL_NAME, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function normalizeTargets(targets: readonly { provider: string; model: string; enabled: boolean }[]): VisionTargetRecord[] {
  const seen = new Map<string, VisionTargetRecord>()
  for (const target of targets) {
    const provider = target.provider.trim()
    const model = target.model.trim()
    if (provider.length > 0 && model.length > 0) {
      seen.set(`${provider}\0${model}`, { provider, model, enabled: target.enabled })
    }
  }
  return [...seen.values()]
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function imageMediaType(value: string): ImageMediaType {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value
  throw new Error(`vision-bridge: unsupported image media type ${JSON.stringify(value)}`)
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default VisionBridgeGateway
