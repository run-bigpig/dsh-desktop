import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { attachmentRef, type ImageTaskRecord, type ImageVersionRecord, type StoredImageRef } from './task-store.ts'
import type { GeminiImageResolution, ImageQuality } from './adapters.ts'

export interface ImageMutationOptions {
  readonly prompt: string
  readonly size?: string
  readonly quality?: ImageQuality
  readonly aspectRatio?: string
  readonly resolution?: GeminiImageResolution
}

export interface ImageMutationResult {
  readonly taskId: string
  readonly revision: number
  readonly status: 'completed'
  readonly model: { readonly provider: string; readonly model: string }
  readonly currentVersionId: string
  readonly operation: 'generate' | 'edit'
  readonly image: StoredImageRef
}

export interface ImageGenerateBatchResult {
  readonly status: 'completed' | 'partial'
  readonly operation: 'generate'
  readonly requested: number
  readonly completed: number
  readonly failed: number
  readonly results: {
    readonly prompt: string
    readonly result: ImageMutationResult
  }[]
  readonly failures: {
    readonly prompt: string
    readonly error: string
  }[]
}

export interface ImageToolService {
  generate(sessionId: string, request: ImageMutationOptions, signal: AbortSignal): Promise<ImageMutationResult>
  editSource(
    sessionId: string,
    source: StoredImageRef,
    instruction: string,
    options: Omit<ImageMutationOptions, 'prompt'>,
    signal: AbortSignal,
  ): Promise<ImageMutationResult>
  edit(
    sessionId: string,
    taskId: string,
    expectedRevision: number,
    instruction: string,
    sourceVersionId: string | undefined,
    options: Omit<ImageMutationOptions, 'prompt'>,
    signal: AbortSignal,
  ): Promise<ImageMutationResult>
  get(sessionId: string, taskId: string): Promise<ImageTaskRecord>
}

const imageRefSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const

const modelSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
  },
} as const

const versionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    parentVersionId: { type: 'string' },
    attachment: { ...imageRefSchema, required: true },
    instruction: { type: 'string', required: true },
    operation: { type: 'string', enum: ['generate', 'edit'], required: true },
    createdAt: { type: 'string', required: true },
  },
} as const

const taskSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    model: { ...modelSchema, required: true },
    status: { type: 'string', enum: ['running', 'completed', 'failed'], required: true },
    currentVersionId: { type: 'string' },
    versions: { type: 'array', required: true, items: versionSchema },
    error: { type: 'string' },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
  },
} as const

const mutationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    status: { type: 'string', enum: ['completed'], required: true },
    model: { ...modelSchema, required: true },
    currentVersionId: { type: 'string', required: true },
    operation: { type: 'string', enum: ['generate', 'edit'], required: true },
    image: { ...imageRefSchema, required: true },
  },
} as const

const batchMutationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'partial'], required: true },
    operation: { type: 'string', enum: ['generate'], required: true },
    requested: { type: 'integer', required: true },
    completed: { type: 'integer', required: true },
    failed: { type: 'integer', required: true },
    results: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          result: { ...mutationSchema, required: true },
        },
      },
    },
    failures: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          error: { type: 'string', required: true },
        },
      },
    },
  },
} as const

const imageOptions = {
  size: { type: 'string', description: 'OpenAI output size as WIDTHxHEIGHT. Ignored for Gemini.' },
  quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], description: 'OpenAI output quality. Ignored for Gemini.' },
  aspect_ratio: {
    type: 'string',
    enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    description: 'Gemini output aspect ratio. Ignored for OpenAI.',
  },
  resolution: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Gemini output resolution. Ignored for OpenAI.' },
} as const

export function defineImageTools(service: ImageToolService) {
  return [
    defineTool({
      name: 'image_generate',
      description: 'Generate one image with prompt, or multiple images with prompts, using the image model selected in StarWeave settings. Each result is saved as its own session-scoped image task and all results appear in one chat card. prompt and prompts are mutually exclusive.',
      parameters: {
        prompt: { type: 'string', description: 'Complete instruction for one image. Mutually exclusive with prompts.' },
        prompts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Complete instructions for multiple images. One image task is created per item. Mutually exclusive with prompt.',
        },
        ...imageOptions,
      },
      output: {
        schema: { oneOf: [mutationSchema, batchMutationSchema] },
        render: (_args, value) => mutationContent(value),
      },
      timeoutMs: 300_000,
      async execute(args, exec): Promise<ImageMutationResult | ImageGenerateBatchResult> {
        const prompts = generationPrompts(args.prompt, args.prompts)
        if (prompts.length === 1) {
          return await service.generate(sessionId(exec), options(prompts[0]!, args), exec.signal)
        }
        const settled = await Promise.allSettled(prompts.map(async prompt => ({
          prompt,
          result: await service.generate(sessionId(exec), options(prompt, args), exec.signal),
        })))
        const results: ImageGenerateBatchResult['results'][number][] = []
        const failures: ImageGenerateBatchResult['failures'][number][] = []
        settled.forEach((entry, index) => {
          const prompt = prompts[index]!
          if (entry.status === 'fulfilled') results.push(entry.value)
          else failures.push({ prompt, error: errorMessage(entry.reason) })
        })
        if (results.length === 0) {
          throw new Error(`image-workbench: all ${String(prompts.length)} image generations failed: ${failures.map((failure, index) => `[${String(index + 1)}] ${failure.error}`).join('; ')}`)
        }
        const result: ImageGenerateBatchResult = {
          status: failures.length === 0 ? 'completed' : 'partial',
          operation: 'generate',
          requested: prompts.length,
          completed: results.length,
          failed: failures.length,
          results,
          failures,
        }
        return result
      },
      presentCall: () => ({ card: 'generic', title: '生成图片', kind: 'fetch' }),
      presentResult: () => ({ card: 'generic', title: '图片已生成' }),
    }),
    defineTool({
      name: 'image_edit',
      description: 'Edit exactly one image attached to the current user message, or continue an existing session-scoped image task when task_id is supplied.',
      parameters: {
        task_id: { type: 'string', description: 'Existing image task UUID. Omit it to edit the image attached to the current user message.' },
        instruction: { type: 'string', required: true, description: 'Complete edit instruction.' },
        source_version_id: { type: 'string', description: 'Version to edit. Defaults to the current version.' },
        expected_revision: { type: 'integer', description: 'Required when task_id is supplied.' },
        ...imageOptions,
      },
      output: {
        schema: mutationSchema,
        render: (_args, value) => mutationContent(value),
      },
      timeoutMs: 300_000,
      async execute(args, exec) {
        const taskId = args.task_id?.trim()
        if (taskId === undefined || taskId.length === 0) {
          if (args.source_version_id !== undefined) {
            throw new Error('image-workbench: source_version_id requires task_id')
          }
          return await service.editSource(
            sessionId(exec),
            currentUserImage(exec),
            requiredText(args.instruction, 'instruction'),
            optionsWithoutPrompt(args),
            exec.signal,
          )
        }
        return await service.edit(
          sessionId(exec),
          taskId,
          requiredRevision(args.expected_revision),
          requiredText(args.instruction, 'instruction'),
          args.source_version_id,
          optionsWithoutPrompt(args),
          exec.signal,
        )
      },
      presentCall: () => ({ card: 'generic', title: '编辑图片', kind: 'fetch' }),
      presentResult: () => ({ card: 'generic', title: '图片版本已更新' }),
    }),
    defineTool({
      name: 'image_task_continue',
      description: 'Continue editing the current version of a session-scoped image task. expected_revision is required for conflict detection.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Image task UUID.' },
        instruction: { type: 'string', required: true, description: 'Next edit instruction.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision.' },
        ...imageOptions,
      },
      output: {
        schema: mutationSchema,
        render: (_args, value) => mutationContent(value),
      },
      timeoutMs: 300_000,
      async execute(args, exec) {
        return await service.edit(
          sessionId(exec),
          args.task_id,
          args.expected_revision,
          args.instruction,
          undefined,
          optionsWithoutPrompt(args),
          exec.signal,
        )
      },
      presentCall: () => ({ card: 'generic', title: '继续编辑图片', kind: 'fetch' }),
      presentResult: () => ({ card: 'generic', title: '图片版本已更新' }),
    }),
    defineTool({
      name: 'image_task_get',
      description: 'Read one image task from the current session, including its current revision and version chain.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Image task UUID.' },
      },
      output: {
        schema: taskSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => service.get(sessionId(exec), args.task_id),
      presentCall: () => ({ card: 'generic', title: '读取图片任务', kind: 'fetch' }),
      presentResult: () => ({ card: 'generic', title: '图片任务' }),
    }),
    defineTool({
      name: 'image_versions',
      description: 'List the versions of one image task from the current session.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Image task UUID.' },
      },
      output: {
        schema: { type: 'array', items: versionSchema },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec): Promise<ImageVersionRecord[]> {
        return (await service.get(sessionId(exec), args.task_id)).versions
      },
      presentCall: () => ({ card: 'generic', title: '读取图片版本', kind: 'fetch' }),
      presentResult: () => ({ card: 'generic', title: '图片版本' }),
    }),
  ]
}

function mutationContent(value: ImageMutationResult | ImageGenerateBatchResult): ContentBlock[] {
  if ('results' in value) {
    return [
      {
        type: 'text',
        text: JSON.stringify({
          status: value.status,
          operation: value.operation,
          requested: value.requested,
          completed: value.completed,
          failed: value.failed,
          results: value.results.map(entry => ({
            prompt: entry.prompt,
            taskId: entry.result.taskId,
            revision: entry.result.revision,
            currentVersionId: entry.result.currentVersionId,
            model: entry.result.model,
          })),
          failures: value.failures,
        }, null, 2),
      },
      ...value.results.map(entry => ({ type: 'image' as const, attachment: attachmentRef(entry.result.image) })),
    ]
  }
  return [
    {
      type: 'text',
      text: JSON.stringify({
        taskId: value.taskId,
        revision: value.revision,
        currentVersionId: value.currentVersionId,
        operation: value.operation,
        model: value.model,
      }, null, 2),
    },
    { type: 'image', attachment: attachmentRef(value.image) },
  ]
}

function generationPrompts(prompt: string | undefined, prompts: readonly string[] | undefined): string[] {
  if (prompt !== undefined && prompts !== undefined) {
    throw new Error('image-workbench: prompt and prompts are mutually exclusive')
  }
  if (prompt !== undefined) return [requiredText(prompt, 'prompt')]
  if (prompts === undefined || prompts.length === 0) {
    throw new Error('image-workbench: exactly one of prompt or prompts is required')
  }
  return prompts.map((value, index) => requiredText(value, `prompts[${String(index)}]`))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function options(prompt: string, args: {
  readonly size?: string
  readonly quality?: ImageQuality
  readonly aspect_ratio?: string
  readonly resolution?: GeminiImageResolution
}): ImageMutationOptions {
  return { prompt: requiredText(prompt, 'prompt'), ...optionsWithoutPrompt(args) }
}

function optionsWithoutPrompt(args: {
  readonly size?: string
  readonly quality?: ImageQuality
  readonly aspect_ratio?: string
  readonly resolution?: GeminiImageResolution
}): Omit<ImageMutationOptions, 'prompt'> {
  return {
    ...(args.size === undefined ? {} : { size: args.size }),
    ...(args.quality === undefined ? {} : { quality: args.quality }),
    ...(args.aspect_ratio === undefined ? {} : { aspectRatio: args.aspect_ratio }),
    ...(args.resolution === undefined ? {} : { resolution: args.resolution }),
  }
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`image-workbench: ${name} must be non-empty`)
  return normalized
}

function requiredRevision(value: number | undefined): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error('image-workbench: expected_revision is required for an explicit image edit target')
  }
  return value as number
}

interface ImageToolExecution {
  readonly agent?: {
    readonly session: Pick<Session, 'id' | 'snapshotEvents'>
  }
}

function currentUserImage(exec: ImageToolExecution): StoredImageRef {
  const events: readonly unknown[] | undefined = exec.agent?.session.snapshotEvents()
  if (events === undefined) throw new Error('image-workbench: current user message does not contain an image')
  const message = events.findLast((value): value is {
    readonly type: 'user/message'
    readonly data: { readonly source: { readonly kind: string }; readonly content: readonly unknown[] }
  } => {
    if (!isRecord(value) || value.type !== 'user/message' || !isRecord(value.data)) return false
    return isRecord(value.data.source)
      && value.data.source.kind === 'user'
      && Array.isArray(value.data.content)
  })
  if (message === undefined) throw new Error('image-workbench: current user message does not contain an image')
  const images = message.data.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'image' || !isStoredImageRef(block.attachment)) return []
    return [{ ...block.attachment }]
  })
  if (images.length === 0) throw new Error('image-workbench: current user message does not contain an image')
  if (images.length !== 1) throw new Error('image-workbench: image_edit requires exactly one source image in the current user message')
  return images[0]!
}

function isStoredImageRef(value: unknown): value is StoredImageRef {
  if (!isRecord(value)) return false
  return typeof value.attachmentId === 'string'
    && typeof value.mediaType === 'string'
    && typeof value.bytes === 'number'
    && typeof value.width === 'number'
    && typeof value.height === 'number'
    && (value.name === undefined || typeof value.name === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sessionId(exec: ImageToolExecution): string {
  if (exec.agent === undefined) throw new Error('image-workbench: image tools require an owning agent session')
  return String(exec.agent.session.id)
}
