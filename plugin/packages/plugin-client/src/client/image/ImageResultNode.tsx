import { useCallback, type ReactNode } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationMatch,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MessageImageTiles } from './MessageImageGallery.tsx'
import type { WorkbenchController } from '../workbench/SessionWorkbench.tsx'

const IMAGE_RESULT_TOOLS = new Set(['image_generate', 'image_edit', 'image_task_continue'])

export interface ImageResultNodeData {
  readonly images: readonly ImageAttachmentRef[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Successful image-tool attachments promoted outside the folded Turn process. */
    'image-results': ImageResultNodeData
  }
}

interface ImageResultState {
  readonly turn: number
  readonly calls: ReadonlyMap<string, boolean>
  readonly images: readonly ImageAttachmentRef[]
  readonly answerSeq?: number
  readonly endSeq?: number
}

export interface ImageResultNodeInjected {
  readonly loadImage: (sessionId: string, attachment: ImageAttachmentRef) => Promise<string>
  readonly controller: WorkbenchController
}

export type ImageResultNodeProps =
  PropsRuntime<'conversation.chat.node', 'image-results'>
  & PropsLocale<'desktop.workbench'>
  & InjectFace<ImageResultNodeInjected>

export function ImageResultNode({
  node, sessionId, loadImage, controller, t,
}: ImageResultNodeProps): ReactNode {
  const imageLoader = useCallback(
    (attachment: ImageAttachmentRef) => loadImage(String(sessionId), attachment),
    [loadImage, sessionId],
  )
  return (
    <MessageImageTiles
      images={node.data.images.map(attachment => ({ attachment }))}
      loadImage={imageLoader}
      align="start"
      sessionId={String(sessionId)}
      controller={controller}
      t={t}
    />
  )
}

export const imageResultDefinition: ConversationNodeDefinition<ImageResultState> = {
  kind: 'desktop-image-results',
  target: 'chat',
  match: event => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'turn/end'
      || event.type === 'tool/call'
      || event.type === 'tool/result'
      || event.type === 'assistant/message') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('image results start requires turn/start')
    return { turn: match.event.data.turn, calls: new Map(), images: [] }
  },
  update: (context, match) => updateImageResultState(context.state, match),
  publication: match => match.event.type === 'turn/end' ? 'immediate' : 'none',
  buildViewNode: (context): ChatConversationViewNode | null => {
    const state = context.state
    if (state === undefined || state.images.length === 0 || state.endSeq === undefined) return null
    const location = context.start?.location ?? context.matches[0]?.location
    if (location === undefined) return null
    return {
      // The answer shares this anchor; a stable trailing key keeps the artifact
      // immediately after it without depending on Harness's private seq offsets.
      key: `zz:${context.key}`,
      kind: 'image-results',
      id: context.id,
      target: 'chat',
      anchorSeq: state.answerSeq ?? state.endSeq,
      location,
      visibility: 'visible',
      data: { images: state.images },
    }
  },
}

function updateImageResultState(state: ImageResultState, match: ConversationMatch): ImageResultState {
  const event = match.event
  if (event.type === 'tool/call') {
    const calls = new Map(state.calls)
    calls.set(String(event.data.callId), IMAGE_RESULT_TOOLS.has(event.data.name))
    return { ...state, calls }
  }
  if (event.type === 'tool/result') {
    const callId = String(event.data.message.source.callId)
    if (state.calls.get(callId) !== true) return state
    const result = event.data.message.content.find(block => block.type === 'tool-result')
    if (result === undefined || result.isError === true) return state
    const additions = result.content.flatMap(content => content.type === 'image' ? [content.attachment] : [])
    return additions.length === 0 ? state : { ...state, images: appendUniqueImages(state.images, additions) }
  }
  if (event.type === 'assistant/message') {
    return hasAssistantReply(event.data.message.content) ? { ...state, answerSeq: event.seq } : state
  }
  return event.type === 'turn/end' ? { ...state, endSeq: event.seq } : state
}

function hasAssistantReply(content: readonly { readonly type: string; readonly text?: string }[]): boolean {
  if (content.some(block => block.type === 'tool-call')) return false
  return content.some(block => block.type === 'text' && block.text?.trim() !== '')
}

function appendUniqueImages(
  current: readonly ImageAttachmentRef[],
  additions: readonly ImageAttachmentRef[],
): readonly ImageAttachmentRef[] {
  const seen = new Set(current.map(image => String(image.attachmentId)))
  return [...current, ...additions.filter((image) => {
    const id = String(image.attachmentId)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })]
}
