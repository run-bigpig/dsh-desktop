import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

export type ImageOperation = 'generate' | 'edit'
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high'
export type GeminiImageResolution = '1K' | '2K' | '4K'

export interface ImageModelDescriptor {
  readonly provider: string
  readonly model: string
  readonly protocol: 'openai-images' | 'google-generative-ai'
  readonly baseURL: string
  readonly apiKey: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface ImageModelCapabilities {
  readonly adapter: 'openai-images' | 'gemini-native-image'
  readonly generate: true
  readonly edit: true
  readonly aspectRatios?: readonly string[]
  readonly resolutions?: readonly GeminiImageResolution[]
  readonly sizes?: readonly string[]
  readonly customSize?: boolean
}

export interface ImageRequest {
  readonly prompt: string
  readonly size?: string
  readonly quality?: ImageQuality
  readonly aspectRatio?: string
  readonly resolution?: GeminiImageResolution
}

export interface ImageEditRequest extends ImageRequest {
  readonly source: {
    readonly data: Uint8Array
    readonly mediaType: ImageMediaType
    readonly name?: string
  }
}

export interface GeneratedImage {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly name: string
}

export interface ImageModelAdapter {
  readonly id: ImageModelCapabilities['adapter']
  supports(descriptor: ImageModelDescriptor): boolean
  capabilities(descriptor: ImageModelDescriptor): ImageModelCapabilities
  generate(descriptor: ImageModelDescriptor, request: ImageRequest, signal: AbortSignal): Promise<GeneratedImage>
  edit(descriptor: ImageModelDescriptor, request: ImageEditRequest, signal: AbortSignal): Promise<GeneratedImage>
}

export function normalizeImageRequestForAdapter(
  adapter: ImageModelCapabilities['adapter'],
  request: ImageRequest,
): ImageRequest {
  if (adapter === 'gemini-native-image') {
    return {
      prompt: request.prompt,
      ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
    }
  }
  return {
    prompt: request.prompt,
    ...(request.size === undefined ? {} : { size: request.size }),
    ...(request.quality === undefined ? {} : { quality: request.quality }),
  }
}

export class ImageModelAdapterRegistry {
  constructor(private readonly adapters: readonly ImageModelAdapter[] = [
    new OpenAIImageAdapter(),
    new GeminiImageAdapter(),
  ]) {}

  resolve(descriptor: ImageModelDescriptor): ImageModelAdapter {
    const adapter = this.adapters.find(candidate => candidate.supports(descriptor))
    if (adapter === undefined) {
      throw new Error(`image-workbench: no adapter supports ${JSON.stringify(descriptor.provider)}/${JSON.stringify(descriptor.model)}`)
    }
    return adapter
  }

  supports(descriptor: Omit<ImageModelDescriptor, 'apiKey'>): boolean {
    return this.adapters.some(adapter => adapter.supports({ ...descriptor, apiKey: '' }))
  }

  capabilities(descriptor: Omit<ImageModelDescriptor, 'apiKey'>): ImageModelCapabilities | undefined {
    const full = { ...descriptor, apiKey: '' }
    return this.adapters.find(adapter => adapter.supports(full))?.capabilities(full)
  }
}

export class OpenAIImageAdapter implements ImageModelAdapter {
  readonly id = 'openai-images' as const

  constructor(private readonly request: typeof fetch = fetch) {}

  supports(descriptor: ImageModelDescriptor): boolean {
    return descriptor.protocol === 'openai-images'
  }

  capabilities(_descriptor: ImageModelDescriptor): ImageModelCapabilities {
    return { adapter: this.id, generate: true, edit: true }
  }

  async generate(descriptor: ImageModelDescriptor, request: ImageRequest, signal: AbortSignal): Promise<GeneratedImage> {
    validateOpenAIRequest(request)
    const body = {
      model: descriptor.model,
      prompt: request.prompt,
      output_format: 'png',
      ...request.size === undefined ? {} : { size: request.size },
      ...request.quality === undefined ? {} : { quality: request.quality },
    }
    return await this.call(descriptor, 'images/generations', {
      method: 'POST',
      headers: requestHeaders(descriptor, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: boundedSignal(signal),
    })
  }

  async edit(descriptor: ImageModelDescriptor, request: ImageEditRequest, signal: AbortSignal): Promise<GeneratedImage> {
    validateOpenAIRequest(request)
    const form = new FormData()
    form.set('model', descriptor.model)
    form.set('prompt', request.prompt)
    form.set('output_format', 'png')
    if (request.size !== undefined) form.set('size', request.size)
    if (request.quality !== undefined) form.set('quality', request.quality)
    form.append('image[]', new Blob([Uint8Array.from(request.source.data).buffer], { type: request.source.mediaType }), request.source.name ?? 'source.png')
    return await this.call(descriptor, 'images/edits', {
      method: 'POST',
      headers: requestHeaders(descriptor),
      body: form,
      signal: boundedSignal(signal),
    })
  }

  private async call(descriptor: ImageModelDescriptor, path: string, init: RequestInit): Promise<GeneratedImage> {
    const response = await this.request(joinURL(descriptor.baseURL, path), init)
    const payload = await responsePayload(response)
    if (!response.ok) throw providerError('OpenAI Images', response.status, payload)
    const encoded = firstOpenAIImage(payload)
    return { data: decodeBase64(encoded), mediaType: 'image/png', name: 'generated.png' }
  }
}

export class GeminiImageAdapter implements ImageModelAdapter {
  readonly id = 'gemini-native-image' as const

  constructor(private readonly request: typeof fetch = fetch) {}

  supports(descriptor: ImageModelDescriptor): boolean {
    return descriptor.protocol === 'google-generative-ai'
  }

  capabilities(_descriptor: ImageModelDescriptor): ImageModelCapabilities {
    return { adapter: this.id, generate: true, edit: true }
  }

  generate(descriptor: ImageModelDescriptor, request: ImageRequest, signal: AbortSignal): Promise<GeneratedImage> {
    return this.call(descriptor, request, request.prompt, signal)
  }

  edit(descriptor: ImageModelDescriptor, request: ImageEditRequest, signal: AbortSignal): Promise<GeneratedImage> {
    return this.call(descriptor, request, [
      { type: 'text', text: request.prompt },
      {
        type: 'image',
        mime_type: request.source.mediaType,
        data: Buffer.from(request.source.data).toString('base64'),
      },
    ], signal)
  }

  private async call(
    descriptor: ImageModelDescriptor,
    request: ImageRequest,
    input: unknown,
    signal: AbortSignal,
  ): Promise<GeneratedImage> {
    if (request.size !== undefined || request.quality !== undefined) {
      throw new Error('image-workbench: Gemini image models use aspect_ratio and resolution, not size or quality')
    }
    const response = await this.request(joinURL(descriptor.baseURL, 'interactions'), {
      method: 'POST',
      headers: requestHeaders(descriptor, { 'content-type': 'application/json' }, 'x-goog-api-key'),
      body: JSON.stringify({
        model: descriptor.model,
        input,
        response_format: {
          type: 'image',
          ...request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio },
          ...request.resolution === undefined ? {} : { image_size: request.resolution },
        },
      }),
      signal: boundedSignal(signal),
    })
    const payload = await responsePayload(response)
    if (!response.ok) throw providerError('Gemini Images', response.status, payload)
    const image = geminiOutputImage(payload)
    return {
      data: decodeBase64(image.data),
      mediaType: imageMediaType(image.mimeType),
      name: imageMediaType(image.mimeType) === 'image/jpeg' ? 'generated.jpg' : 'generated.png',
    }
  }
}

function validateOpenAIRequest(request: ImageRequest): void {
  if (request.aspectRatio !== undefined || request.resolution !== undefined) {
    throw new Error('image-workbench: OpenAI image models use size, not aspect_ratio or resolution')
  }
}

function requestHeaders(
  descriptor: ImageModelDescriptor,
  extra: Readonly<Record<string, string>> = {},
  credentialHeader = 'authorization',
): Headers {
  const headers = new Headers(descriptor.headers)
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  headers.set(credentialHeader, credentialHeader === 'authorization' ? `Bearer ${descriptor.apiKey}` : descriptor.apiKey)
  return headers
}

function boundedSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(180_000)])
}

function joinURL(baseURL: string, path: string): URL {
  return new URL(`${baseURL.replace(/\/+$/u, '')}/${path}`)
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try { return JSON.parse(text) } catch { return text }
}

function providerError(provider: string, status: number, payload: unknown): Error {
  const record = asRecord(payload)
  const nested = asRecord(record?.error)
  const message = typeof nested?.message === 'string'
    ? nested.message
    : typeof record?.message === 'string'
      ? record.message
      : typeof payload === 'string'
        ? payload.slice(0, 500)
        : 'request failed'
  return new Error(`image-workbench: ${provider} request failed (${status}): ${message}`)
}

function firstOpenAIImage(payload: unknown): string {
  const data = asRecord(payload)?.data
  const first = Array.isArray(data) ? asRecord(data[0]) : undefined
  if (typeof first?.b64_json !== 'string' || first.b64_json.length === 0) {
    throw new Error('image-workbench: OpenAI Images returned no image data')
  }
  return first.b64_json
}

function geminiOutputImage(payload: unknown): { data: string; mimeType?: string } {
  const record = asRecord(payload)
  const direct = geminiImageContent(record?.output_image) ?? geminiImageContent(record?.outputImage)
  if (direct !== undefined) return direct

  let image: { data: string; mimeType?: string } | undefined
  for (const step of arrayOf(record?.steps)) {
    const stepRecord = asRecord(step)
    if (stepRecord?.type !== 'model_output') continue
    for (const content of arrayOf(stepRecord.content)) {
      const candidate = geminiTypedImageContent(content)
      if (candidate !== undefined) image = candidate
    }
  }
  if (image !== undefined) return image

  for (const output of arrayOf(record?.outputs)) {
    const candidate = geminiTypedImageContent(output)
    if (candidate !== undefined) image = candidate
  }
  if (image !== undefined) return image

  throw new Error(`image-workbench: Gemini returned no image data (${geminiResponseShape(record)})`)
}

function geminiTypedImageContent(value: unknown): { data: string; mimeType?: string } | undefined {
  const record = asRecord(value)
  return record?.type === 'image' ? geminiImageContent(record) : undefined
}

function geminiImageContent(value: unknown): { data: string; mimeType?: string } | undefined {
  const image = asRecord(value)
  if (typeof image?.data !== 'string' || image.data.length === 0) return undefined
  const mimeType = typeof image.mime_type === 'string'
    ? image.mime_type
    : typeof image.mimeType === 'string'
      ? image.mimeType
      : undefined
  return { data: image.data, ...(mimeType === undefined ? {} : { mimeType }) }
}

function geminiResponseShape(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined) return 'response is not an object'
  const details: string[] = []
  if (typeof payload.status === 'string') details.push(`status=${payload.status}`)
  const steps = arrayOf(payload.steps).map(asRecord).filter(value => value !== undefined)
  if (steps.length > 0) {
    details.push(`stepTypes=${distinctStrings(steps.map(step => step.type)).join(',') || 'unknown'}`)
    const contentTypes = steps
      .filter(step => step.type === 'model_output')
      .flatMap(step => arrayOf(step.content))
      .map(content => asRecord(content)?.type)
    details.push(`modelContentTypes=${distinctStrings(contentTypes).join(',') || 'none'}`)
  }
  const outputs = arrayOf(payload.outputs)
  if (outputs.length > 0) {
    details.push(`outputTypes=${distinctStrings(outputs.map(output => asRecord(output)?.type)).join(',') || 'unknown'}`)
  }
  if (payload.output_image !== undefined || payload.outputImage !== undefined) details.push('outputImage=missing-data')
  return details.join('; ') || `fields=${Object.keys(payload).sort().slice(0, 12).join(',') || 'none'}`
}

function distinctStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))]
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function decodeBase64(value: string): Uint8Array {
  const data = Buffer.from(value, 'base64')
  if (data.byteLength === 0) throw new Error('image-workbench: provider returned an empty image')
  return data
}

function imageMediaType(value: string | undefined): ImageMediaType {
  if (value === undefined || value === 'image/png') return 'image/png'
  if (value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value
  throw new Error(`image-workbench: unsupported generated image type ${JSON.stringify(value)}`)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
