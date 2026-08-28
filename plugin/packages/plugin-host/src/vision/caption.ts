import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createUserMessage, type ContentBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'

const TEST_TIMEOUT_MS = 60_000
const CAPTION_TIMEOUT_MS = 180_000
const CAPTION_PROMPT = [
  'Describe this image for a text-only assistant.',
  'Cover the scene, layout, and transcribe visible text exactly.',
  'Be concise. Do not mention that you are a vision model. Do not ask follow-up questions.',
].join(' ')

export interface VisionClientConfig {
  readonly provider: string
  readonly model: string
}

export async function testVisionConnection(
  llm: LlmRuntime,
  config: VisionClientConfig,
  signal?: AbortSignal,
): Promise<{ readonly kind: 'ok'; readonly message: string } | { readonly kind: 'error'; readonly message: string }> {
  try {
    await completeText(llm, config, [{ type: 'text', text: 'Reply with OK only.' }], combineSignal(signal, TEST_TIMEOUT_MS), 16)
    return { kind: 'ok', message: 'Harness model responded successfully.' }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

export async function captionImage(
  llm: LlmRuntime,
  config: VisionClientConfig,
  image: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<string> {
  const text = await completeText(llm, config, [
    { type: 'text', text: CAPTION_PROMPT },
    { type: 'image', attachment: image },
  ], combineSignal(signal, CAPTION_TIMEOUT_MS), 1_024)
  if (text.trim().length === 0) throw new Error('vision-bridge: vision model returned empty content')
  return text.trim()
}

async function completeText(
  llm: LlmRuntime,
  config: VisionClientConfig,
  content: ContentBlock[],
  signal: AbortSignal,
  maxTokens: number,
): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider: config.provider,
    model: config.model,
    messages: [createUserMessage({
      content,
      source: { kind: 'plugin', plugin: 'dsh-desktop-vision' },
    })],
    maxTokens,
    signal,
  })) assembler.push(chunk)
  if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
    throw new Error(`vision-bridge: vision model failed: ${assembler.finish.failure.message}`)
  }
  const blocks = assembler.blocks()
  const visible = blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text).join('')
  if (visible.trim().length > 0) return visible
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map(block => block.text).join('')
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}
