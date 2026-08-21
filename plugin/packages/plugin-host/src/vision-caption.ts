const TEST_TIMEOUT_MS = 30_000
const CAPTION_TIMEOUT_MS = 180_000
const CAPTION_PROMPT = [
  'Describe this image for a text-only assistant.',
  'Cover the scene, layout, and transcribe visible text exactly.',
  'Be concise. Do not mention that you are a vision model. Do not ask follow-up questions.',
].join(' ')

export interface VisionClientConfig {
  readonly baseURL: string
  readonly apiKey: string
  readonly model: string
}

export interface VisionImageBytes {
  readonly attachmentId: string
  readonly mediaType: string
  readonly name?: string
  readonly data: Uint8Array
}

export async function testVisionConnection(
  config: VisionClientConfig,
  signal?: AbortSignal,
): Promise<{ readonly kind: 'ok'; readonly message: string } | { readonly kind: 'error'; readonly message: string }> {
  try {
    const response = await fetch(joinEndpoint(config.baseURL, '/models'), {
      headers: { Authorization: `Bearer ${config.apiKey.trim()}` },
      signal: combineSignal(signal, TEST_TIMEOUT_MS),
    })
    const value = await readJson(response)
    if (!response.ok) return { kind: 'error', message: errorMessageFromBody(value, `HTTP ${String(response.status)}`) }
    const record = asRecord(value)
    const count = Array.isArray(record?.data) ? record.data.length : undefined
    return { kind: 'ok', message: count === undefined ? 'Connected.' : `Connected (${String(count)} models).` }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

export async function captionImage(
  config: VisionClientConfig,
  image: VisionImageBytes,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(joinEndpoint(config.baseURL, '/chat/completions'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    signal: combineSignal(signal, CAPTION_TIMEOUT_MS),
    body: JSON.stringify({
      model: config.model,
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: CAPTION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` } },
        ],
      }],
    }),
  })
  const value = await readJson(response)
  if (!response.ok) {
    throw new Error(`vision-bridge: vision model failed: ${errorMessageFromBody(value, `HTTP ${String(response.status)}`)}`)
  }
  const record = asRecord(value)
  const first = Array.isArray(record?.choices) ? asRecord(record.choices[0]) : undefined
  const message = asRecord(first?.message)
  const text = textFromContent(message?.content) || (typeof message?.reasoning_content === 'string' ? message.reasoning_content : '')
  if (text.trim().length === 0) throw new Error('vision-bridge: vision model returned empty content')
  return text.trim()
}

function joinEndpoint(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/u, '')}${path.startsWith('/') ? path : `/${path}`}`
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(item => asRecord(item)?.text).filter((text): text is string => typeof text === 'string').join('')
}

function errorMessageFromBody(value: unknown, fallback: string): string {
  const record = asRecord(value)
  const error = asRecord(record?.error)
  if (typeof error?.message === 'string' && error.message.length > 0) return error.message
  if (typeof record?.message === 'string' && record.message.length > 0) return record.message
  return fallback
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try { return JSON.parse(text) as unknown } catch { return text }
}
