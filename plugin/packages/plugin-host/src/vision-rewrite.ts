import { contentHasImage, freezeMessage, type ContentBlock, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'

export const LOOK_AT_REASONING = '查看图片以理解用户提供的内容。'

export function messagesHaveImage(messages: readonly Message[]): boolean {
  return messages.some(message => contentHasImage(message.content))
}

export function uniqueRequestImages(messages: readonly Message[]): Extract<ContentBlock, { type: 'image' }>[] {
  const images: Extract<ContentBlock, { type: 'image' }>[] = []
  for (const message of messages) collectImageBlocks(message.content, images)
  const seen = new Set<string>()
  return images.filter(image => {
    const id = String(image.attachment.attachmentId)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function hasLookAtToolSinceLastUser(messages: readonly Message[], toolName: string): boolean {
  let from = 0
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === 'user' && !message.content.some(block => block.type === 'tool-result')) from = index + 1
  }
  return messages.slice(from).some(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'tool-call' && block.name === toolName))
}

export function allImagesCaptioned(messages: readonly Message[], captions: ReadonlyMap<string, string>): boolean {
  return uniqueRequestImages(messages).every(image => captions.has(String(image.attachment.attachmentId)))
}

export function stripLookAtTool(options: GenerateOptions, toolName: string): GenerateOptions {
  if (options.tools === undefined) return options
  const tools = options.tools.filter(tool => typeof tool !== 'object' || tool === null || !('name' in tool) || tool.name !== toolName)
  if (tools.length === options.tools.length) return options
  if (tools.length > 0) return { ...options, tools }
  const { tools: _tools, ...withoutTools } = options
  return withoutTools
}

export function rewriteOptions(options: GenerateOptions, captions: ReadonlyMap<string, string>): GenerateOptions {
  return {
    ...options,
    messages: options.messages.map(message => freezeMessage({
      ...message,
      content: replaceImagesInContent(message.content, captions),
    })),
  }
}

export function normalizeLookAtReplayState(options: GenerateOptions, toolName: string): GenerateOptions {
  let changed = false
  const messages = options.messages.map(message => {
    if (message.role !== 'assistant') return message
    const hasLookAtCall = message.content.some(block => block.type === 'tool-call' && block.name === toolName)
    const hasLookAtReasoning = message.content.some(block => block.type === 'reasoning' && block.text.startsWith('查看图片'))
    if (!hasLookAtCall && !hasLookAtReasoning) return message
    const source = modelSourceOf(message)
    const needsReasoning = hasLookAtCall
      && !message.content.some(block => block.type === 'reasoning' && block.text.trim().length > 0)
    const needsReplayDrop = source?.replayState !== undefined
    if (!needsReasoning && !needsReplayDrop) return message
    changed = true
    return freezeMessage({
      ...message,
      content: needsReasoning
        ? [{ type: 'reasoning' as const, text: LOOK_AT_REASONING }, ...message.content]
        : message.content,
      source: needsReplayDrop && source !== undefined
        ? { kind: 'model' as const, provider: source.provider, model: source.model }
        : message.source,
    })
  })
  return changed ? { ...options, messages } : options
}

function collectImageBlocks(content: readonly ContentBlock[], into: Extract<ContentBlock, { type: 'image' }>[]): void {
  for (const block of content) {
    if (block.type === 'image') into.push(block)
    if (block.type === 'tool-result') collectImageBlocks(block.content, into)
  }
}

function replaceImagesInContent(content: readonly ContentBlock[], captions: ReadonlyMap<string, string>): ContentBlock[] {
  return content.map(block => {
    if (block.type === 'image') {
      const caption = captions.get(String(block.attachment.attachmentId))
      if (caption === undefined) throw new Error(`vision-bridge: missing caption for ${String(block.attachment.attachmentId)}`)
      const name = block.attachment.name === undefined || block.attachment.name.length === 0 ? 'image' : block.attachment.name
      return { type: 'text' as const, text: `[Image: ${name}]\n${caption}` }
    }
    if (block.type === 'tool-result') return { ...block, content: replaceImagesInContent(block.content, captions) }
    return block
  })
}

function modelSourceOf(message: Message): {
  readonly provider: string
  readonly model: string
  readonly replayState?: unknown
} | undefined {
  const source = message.source
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  if (record.kind !== 'model' || typeof record.provider !== 'string' || typeof record.model !== 'string') return undefined
  return {
    provider: record.provider,
    model: record.model,
    ...(record.replayState === undefined ? {} : { replayState: record.replayState }),
  }
}
