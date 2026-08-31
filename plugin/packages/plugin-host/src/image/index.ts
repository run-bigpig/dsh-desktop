import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ImageModelAdapterRegistry,
  normalizeImageRequestForAdapter,
  type ImageModelDescriptor,
  type ImageRequest,
} from './adapters.ts'
import {
  attachmentRef,
  ImageTaskStore,
  storedImageRef,
  type ImageTaskRecord,
  type StoredImageRef,
} from './task-store.ts'
import {
  defineImageTools,
  type ImageMutationOptions,
  type ImageMutationResult,
  type ImageToolService,
} from './tools.ts'
import type {
  ImageModelCatalogGroup,
  ImageModelSaveRequest,
  ImageModelSettingsSnapshot,
  ImageSettingsMutationResult,
} from '../shared/types.ts'

export interface ImageGatewayConfig {
  readonly path: string
}

interface ImageSettingsDocument {
  readonly version: 1
  readonly image: { readonly provider: string; readonly model: string }
}

const EMPTY_DOCUMENT: ImageSettingsDocument = { version: 1, image: { provider: '', model: '' } }
const DEFAULT_PROVIDER_CONFIG = {
  openai: {
    protocol: 'openai-images',
    baseURL: 'https://api.openai.com/v1',
    credential: 'OPENAI_API_KEY',
  },
  google: {
    protocol: 'google-generative-ai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    credential: 'GEMINI_API_KEY',
  },
} as const

export class ImageGateway extends TypertRemoteService implements ImageToolService {
  static inject = ['llm', 'attachments', 'tools', 'settings', 'credentials']
  static Config: z<ImageGatewayConfig> = z.object({ path: z.string().required() })

  private readonly root: string
  private readonly settingsFile: string
  private readonly tasks: ImageTaskStore
  private readonly adapters = new ImageModelAdapterRegistry()
  private document: ImageSettingsDocument = EMPTY_DOCUMENT
  private chain: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: ImageGatewayConfig) {
    super(ctx, 'imageWorkbench')
    this.root = resolve(config.path)
    this.settingsFile = resolve(this.root, 'settings.json')
    this.tasks = new ImageTaskStore(this.root)
  }

  protected async [Service.init](): Promise<void> {
    this.document = await this.readSettings()
    for (const tool of defineImageTools(this)) {
      this.ctx.effect(() => this.ctx.tools.register(tool), `desktop-image-workbench: ${tool.name} tool`)
    }
    this.ctx.get('systemPrompt')?.section({
      name: 'desktop-image-workbench',
      order: 83,
      text: [
        'Use image_generate with prompt for one new image, or prompts for multiple differently instructed images in one tool call; use image_edit or image_task_continue for later edits.',
        'When the current user message contains exactly one reference or Image Studio guide image, call image_edit without task_id; the tool edits that attached image directly.',
        'Before editing an existing task, read its current revision with image_task_get when the revision is not already known.',
        'Image tasks are session-scoped; never invent task or version ids.',
      ].join(' '),
    })
  }

  @Remote('snapshot')
  snapshot(): Promise<ImageModelSettingsSnapshot> {
    return this.enqueue(async () => ({
      image: { ...this.document.image },
      catalog: await this.listCatalog(),
    }))
  }

  @Remote('save')
  save(request: ImageModelSaveRequest): Promise<ImageSettingsMutationResult> {
    return this.enqueue(async () => {
      const image = {
        provider: request.provider.trim(),
        model: request.model.trim(),
      }
      if ((image.provider.length === 0) !== (image.model.length === 0)) {
        throw new Error('image-workbench: both provider and model are required')
      }
      if (image.provider.length > 0) await this.resolveDescriptor(image, false)
      this.document = { version: 1, image }
      await this.persistSettings()
      return { ok: true }
    })
  }

  async generate(sessionId: string, request: ImageMutationOptions, signal: AbortSignal): Promise<ImageMutationResult> {
    const selection = this.selectedModel()
    const descriptor = await this.resolveDescriptor(selection, true)
    const adapter = this.adapters.resolve(descriptor)
    const task = await this.tasks.beginGenerate(sessionId, selection)
    try {
      const generated = await adapter.generate(
        descriptor,
        normalizeImageRequestForAdapter(adapter.id, imageRequest(request)),
        signal,
      )
      const ref = await this.ctx.attachments.saveImage(generated)
      const completed = await this.tasks.complete(sessionId, task.id, task.revision, {
        attachment: storedImageRef(ref),
        instruction: request.prompt,
        operation: 'generate',
      })
      return mutationResult(completed, 'generate')
    } catch (error) {
      await this.tasks.fail(sessionId, task.id, task.revision, error)
      throw withTaskId(error, task.id)
    }
  }

  async edit(
    sessionId: string,
    taskId: string,
    expectedRevision: number,
    instruction: string,
    sourceVersionId: string | undefined,
    options: Omit<ImageMutationOptions, 'prompt'>,
    signal: AbortSignal,
  ): Promise<ImageMutationResult> {
    const existing = await this.tasks.get(sessionId, taskId)
    const descriptor = await this.resolveDescriptor(existing.model, true)
    const adapter = this.adapters.resolve(descriptor)
    const begun = await this.tasks.beginEdit(sessionId, taskId, expectedRevision, sourceVersionId)
    try {
      const stored = await this.ctx.attachments.readImage(attachmentRef(begun.source.attachment), signal)
      const generated = await adapter.edit(descriptor, {
        ...normalizeImageRequestForAdapter(adapter.id, imageRequest({ prompt: instruction, ...options })),
        source: {
          data: stored.data,
          mediaType: stored.ref.mediaType,
          ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
        },
      }, signal)
      const ref = await this.ctx.attachments.saveImage(generated)
      const completed = await this.tasks.complete(sessionId, taskId, begun.task.revision, {
        parentVersionId: begun.source.id,
        attachment: storedImageRef(ref),
        instruction,
        operation: 'edit',
      })
      return mutationResult(completed, 'edit')
    } catch (error) {
      await this.tasks.fail(sessionId, taskId, begun.task.revision, error)
      throw error
    }
  }

  async editSource(
    sessionId: string,
    source: StoredImageRef,
    instruction: string,
    options: Omit<ImageMutationOptions, 'prompt'>,
    signal: AbortSignal,
  ): Promise<ImageMutationResult> {
    const selection = this.selectedModel()
    const descriptor = await this.resolveDescriptor(selection, true)
    const adapter = this.adapters.resolve(descriptor)
    const begun = await this.tasks.beginFromSource(sessionId, selection, source)
    try {
      const stored = await this.ctx.attachments.readImage(attachmentRef(source), signal)
      const generated = await adapter.edit(descriptor, {
        ...normalizeImageRequestForAdapter(adapter.id, imageRequest({ prompt: instruction, ...options })),
        source: {
          data: stored.data,
          mediaType: stored.ref.mediaType,
          ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
        },
      }, signal)
      const ref = await this.ctx.attachments.saveImage(generated)
      const completed = await this.tasks.complete(sessionId, begun.task.id, begun.task.revision, {
        parentVersionId: begun.source.id,
        attachment: storedImageRef(ref),
        instruction,
        operation: 'edit',
      })
      return mutationResult(completed, 'edit')
    } catch (error) {
      await this.tasks.fail(sessionId, begun.task.id, begun.task.revision, error)
      throw withTaskId(error, begun.task.id)
    }
  }

  get(sessionId: string, taskId: string): Promise<ImageTaskRecord> {
    return this.tasks.get(sessionId, taskId)
  }

  private selectedModel(): ImageSettingsDocument['image'] {
    if (this.document.image.provider.length === 0 || this.document.image.model.length === 0) {
      throw new Error('image-workbench: select an image model in StarWeave settings first')
    }
    return this.document.image
  }

  private async listCatalog(): Promise<ImageModelCatalogGroup[]> {
    const groups: ImageModelCatalogGroup[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      const directory = this.ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider.id)
      if (directory === undefined) continue
      try {
        const profile = this.providerProfile(directory.settingsNs, directory.settingsPath)
        const connection = await this.connectionFacts(provider.id, profile, false)
        if (connection === undefined) continue
        const credential = await this.ctx.credentials.describe(credentialRef(connection.credential))
        if (!credential.configured) continue
        const models = await this.ctx.llm.listModels(provider.id)
        const candidates = models.flatMap(model => {
          const descriptor = {
            provider: provider.id,
            model: model.id,
            protocol: connection.protocol,
            baseURL: connection.baseURL,
            ...(connection.headers === undefined ? {} : { headers: connection.headers }),
          } as const
          const capabilities = this.adapters.capabilities(descriptor)
          return capabilities === undefined ? [] : [{
            id: model.id,
            name: model.name,
            capabilities,
          }]
        })
        if (candidates.length > 0) groups.push({
          provider: provider.id,
          providerName: provider.name,
          models: candidates,
        })
      } catch (error) {
        this.ctx.logger.warn(`desktop-image-workbench: failed to inspect ${provider.id}: ${String(error)}`)
      }
    }
    return groups
  }

  private async resolveDescriptor(
    selection: ImageSettingsDocument['image'],
    includeSecret: boolean,
  ): Promise<ImageModelDescriptor> {
    const provider = this.ctx.llm.listProviders().find(entry => entry.id === selection.provider)
    if (provider === undefined) throw new Error(`image-workbench: Harness provider ${JSON.stringify(selection.provider)} is not active`)
    const directory = this.ctx.llm.listConfigurableProviders().find(entry => entry.provider === selection.provider)
    if (directory === undefined) throw new Error('image-workbench: the selected provider does not expose a Harness settings profile')
    const profile = this.providerProfile(directory.settingsNs, directory.settingsPath)
    const connection = await this.connectionFacts(selection.provider, profile, includeSecret)
    if (connection === undefined) throw new Error('image-workbench: the selected provider is not configured for a supported image API')
    const models = await this.ctx.llm.listModels(selection.provider)
    if (!models.some(model => model.id === selection.model)) {
      throw new Error(`image-workbench: model ${JSON.stringify(selection.model)} is not listed by the Harness provider`)
    }
    const descriptor: ImageModelDescriptor = {
      provider: selection.provider,
      model: selection.model,
      protocol: connection.protocol,
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
      ...(connection.headers === undefined ? {} : { headers: connection.headers }),
    }
    this.adapters.resolve(descriptor)
    return descriptor
  }

  private providerProfile(settingsNs: string, settingsPath: readonly string[]): Record<string, unknown> {
    const section = this.ctx.settings.get(settingsNs)
    const profile = valueAtPath(section, settingsPath)
    if (!isRecord(profile)) throw new Error('image-workbench: provider profile is missing from Harness settings')
    return profile
  }

  private async connectionFacts(
    provider: string,
    profile: Record<string, unknown>,
    includeSecret: boolean,
  ): Promise<{
    protocol: ImageModelDescriptor['protocol']
    baseURL: string
    credential: string
    apiKey: string
    headers?: Readonly<Record<string, string>>
  } | undefined> {
    const defaults = DEFAULT_PROVIDER_CONFIG[provider as keyof typeof DEFAULT_PROVIDER_CONFIG]
    const api = typeof profile.api === 'string' ? profile.api : undefined
    const protocol = api === 'google-generative-ai'
      ? 'google-generative-ai'
      : api === 'openai-completions' || api === 'openai-responses'
        ? 'openai-images'
        : defaults?.protocol
    if (protocol === undefined) return undefined
    if (provider !== 'google' && provider !== 'openai' && api === undefined) return undefined
    const configuredBaseURL = typeof profile.baseURL === 'string' ? profile.baseURL.trim() : ''
    const baseURL = configuredBaseURL || (defaults?.protocol === protocol ? defaults.baseURL : undefined)
    if (baseURL === undefined) return undefined
    const configuredCredential = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : ''
    const credential = configuredCredential || defaults?.credential
    if (credential === undefined) return undefined
    const headers = stringRecord(profile.headers)
    let apiKey = ''
    if (includeSecret) {
      apiKey = (await this.ctx.credentials.resolve(credentialRef(credential)))?.value ?? ''
      if (apiKey.length === 0) throw new Error(`image-workbench: credential ${credential} is not configured`)
    }
    return {
      protocol,
      baseURL,
      credential,
      apiKey,
      ...(headers === undefined ? {} : { headers }),
    }
  }

  private async readSettings(): Promise<ImageSettingsDocument> {
    try {
      return parseSettings(await readFile(this.settingsFile, 'utf8'))
    } catch (error) {
      if (isEnoent(error)) return EMPTY_DOCUMENT
      throw error
    }
  }

  private persistSettings(): Promise<void> {
    return writeFileAtomic(this.settingsFile, `${JSON.stringify(this.document, null, 2)}\n`, {
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

function imageRequest(request: ImageMutationOptions): ImageRequest {
  return {
    prompt: request.prompt.trim(),
    ...(request.size === undefined ? {} : { size: request.size }),
    ...(request.quality === undefined ? {} : { quality: request.quality }),
    ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
    ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
  }
}

function mutationResult(task: ImageTaskRecord, operation: 'generate' | 'edit'): ImageMutationResult {
  const version = task.versions.at(-1)
  if (task.status !== 'completed' || task.currentVersionId === undefined || version === undefined) {
    throw new Error(`image-workbench: task ${task.id} did not complete with an image version`)
  }
  return {
    taskId: task.id,
    revision: task.revision,
    status: 'completed',
    model: { ...task.model },
    currentVersionId: task.currentVersionId,
    operation,
    image: { ...version.attachment },
  }
}

function parseSettings(text: string): ImageSettingsDocument {
  let value: unknown
  try { value = JSON.parse(text) } catch (error) {
    throw new Error('image-workbench: settings are not valid JSON', { cause: error })
  }
  const record = isRecord(value) ? value : undefined
  const image = isRecord(record?.image) ? record.image : undefined
  if (record?.version !== 1 || typeof image?.provider !== 'string' || typeof image.model !== 'string') {
    throw new Error('image-workbench: settings document is invalid')
  }
  return { version: 1, image: { provider: image.provider.trim(), model: image.model.trim() } }
}

function withTaskId(error: unknown, taskId: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${message} (image task ${taskId})`, { cause: error })
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (!entries.every(([, entry]) => typeof entry === 'string')) return undefined
  return Object.fromEntries(entries) as Readonly<Record<string, string>>
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default ImageGateway
