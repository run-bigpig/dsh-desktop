import { useCallback, type ReactNode } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationLocationData,
  ConversationMatch,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MessageImageTiles } from './MessageImageGallery.tsx'
import type { WorkbenchController } from '../workbench/SessionWorkbench.tsx'

const IMAGE_RESULT_TOOLS = new Set(['image_generate', 'image_edit', 'image_task_continue'])

interface StoredImageResult {
  readonly seq: number
  readonly attachment: ImageAttachmentRef
}

export interface ImageResultTurnData {
  readonly images: readonly StoredImageResult[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Successful image-tool attachments promoted outside the folded Turn process. */
    'desktop-image-results': ImageResultTurnData
  }
}

interface ImageResultState extends ImageResultTurnData {
  readonly turn: number
  readonly calls: ReadonlyMap<string, boolean>
}

export interface ImageResultTailInjected {
  readonly loadImage: (sessionId: string, attachment: ImageAttachmentRef) => Promise<string>
  readonly controller: WorkbenchController
}

export type ImageResultTailProps =
  PropsRuntime<'conversation.chat.turnTail'>
  & { readonly matched: readonly ImageAttachmentRef[] }
  & PropsLocale<'desktop.workbench'>
  & InjectFace<ImageResultTailInjected>

export function ImageResultTail({
  matched, sessionId, loadImage, controller, t,
}: ImageResultTailProps): ReactNode {
  const imageLoader = useCallback(
    (attachment: ImageAttachmentRef) => loadImage(String(sessionId), attachment),
    [loadImage, sessionId],
  )
  return (
    <MessageImageTiles
      images={matched.map(attachment => ({ attachment }))}
      loadImage={imageLoader}
      align="start"
      sessionId={String(sessionId)}
      controller={controller}
      t={t}
    />
  )
}

export function selectImageResultTail(owner: TurnTailOwnerProps): readonly ImageAttachmentRef[] | null {
  const data = owner.turn.data.get('desktop-image-results')
  if (data === undefined) return null
  const images = data.images.filter(image => image.seq <= owner.seq).map(image => image.attachment)
  return images.length === 0 ? null : images
}

export const imageResultDefinition: ConversationNodeDefinition<ImageResultState> = {
  kind: 'desktop-image-results',
  match: event => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('image results start requires turn/start')
    return { turn: match.event.data.turn, calls: new Map(), images: [] }
  },
  update: (context, match) => updateImageResultState(context.state, match),
  buildLocationData: (context, scope): ConversationLocationData | null => {
    if (scope !== 'turn' || context.state === undefined) return null
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'desktop-image-results',
      value: { images: context.state.images },
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
  if (event.type !== 'tool/result') return state
  const callId = String(event.data.message.source.callId)
  if (state.calls.get(callId) !== true) return state
  const result = event.data.message.content.find(block => block.type === 'tool-result')
  if (result === undefined || result.isError === true) return state
  const additions = result.content.flatMap(content => content.type === 'image'
    ? [{ seq: event.seq, attachment: content.attachment }]
    : [])
  return additions.length === 0 ? state : { ...state, images: appendUniqueImages(state.images, additions) }
}

function appendUniqueImages(
  current: readonly StoredImageResult[],
  additions: readonly StoredImageResult[],
): readonly StoredImageResult[] {
  const seen = new Set(current.map(image => String(image.attachment.attachmentId)))
  return [...current, ...additions.filter((image) => {
    const id = String(image.attachment.attachmentId)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })]
}
