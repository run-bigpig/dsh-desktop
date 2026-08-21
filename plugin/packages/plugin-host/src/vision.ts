import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentId, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { CallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
  visionEndpointReady,
  type VisionBridgeDocument,
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
  static inject = ['llm', 'attachments', 'tools']
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
        : mergeVision(this.document.vision, request.vision)
      const targets = request.targets === undefined ? this.document.targets : normalizeTargets(request.targets)
      this.document = { version: 1, vision, targets }
      await this.persist()
      return { ok: true }
    })
  }

  @Remote('testConnection')
  testConnection(request: VisionTestRequest): Promise<VisionTestResult> {
    return this.enqueue(async () => {
      const apiKey = request.apiKey === undefined || request.apiKey.length === 0
        ? this.document.vision.apiKey
        : request.apiKey
      const config = { baseURL: request.baseURL.trim(), model: request.model.trim(), apiKey }
      if (!visionEndpointReady(config)) {
        return { kind: 'error', message: 'Base URL, model, and API key are required.' }
      }
      return testVisionConnection(config)
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
    return visionEndpointReady(this.document.vision) && isTargetEnabled(this.document.targets, provider, model)
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
    if (!visionEndpointReady(this.document.vision)) {
      throw new Error('vision-bridge: configure a vision model before sending images')
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
      const caption = await captionImage(config, {
        attachmentId: image.attachmentId,
        mediaType: stored.ref.mediaType,
        data: stored.data,
        ...(image.name === undefined ? {} : { name: image.name }),
      }, signal)
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
        baseURL: this.document.vision.baseURL,
        model: this.document.vision.model,
        hasApiKey: this.document.vision.apiKey.trim().length > 0,
      },
      targets: this.document.targets.map(target => ({ ...target })),
      catalog: await this.listCatalog(),
    }
  }

  private async listCatalog(): Promise<VisionCatalogGroup[]> {
    const groups: VisionCatalogGroup[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      try {
        const models = await this.ctx.llm.listModels(provider.id)
        groups.push({
          provider: provider.id,
          providerName: provider.name,
          models: models.map(model => ({
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

export default VisionBridgeGateway
