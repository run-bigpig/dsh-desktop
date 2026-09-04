import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ComposerAttachment, MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StoredImageView } from '@run-bigpig/dsh-desktop-plugin-host/types'
import { HarnessImage, HarnessImageGroup } from './ImagePreview.tsx'
import type { WorkbenchController } from '../workbench/SessionWorkbench.tsx'
import css from './MessageImageGallery.module.css'

export interface MessageImageGalleryInjected {
  readonly controller: WorkbenchController
}

export type MessageImageGalleryProps =
  PropsRuntime<'conversation.message.images'>
  & PropsLocale<'desktop.workbench'>
  & InjectFace<MessageImageGalleryInjected>

export function MessageImageGallery({
  images, loadImage, align, sessionId, controller, t,
}: MessageImageGalleryProps): ReactNode {
  if (images.length === 0 || sessionId === undefined) return null
  return (
    <MessageImageTiles
      images={images}
      loadImage={loadImage}
      align={align}
      sessionId={String(sessionId)}
      controller={controller}
      t={t}
    />
  )
}

export interface MessageImageTilesProps {
  readonly images: readonly MessageImageSource[]
  readonly loadImage: (attachment: ImageAttachmentRef) => Promise<string>
  readonly align: 'start' | 'end'
  readonly sessionId: string
  readonly controller: WorkbenchController
  readonly t: MessageImageGalleryProps['t']
}

export function MessageImageTiles({
  images, loadImage, align, sessionId, controller, t,
}: MessageImageTilesProps): ReactNode {
  const attachments = images.flatMap(image => 'attachment' in image ? [image.attachment] : [])
  if (attachments.length === 0) return null
  const variant = attachments.length === 1 ? 'single' : 'tile'
  return (
    <HarnessImageGroup label={t('imagePreview')} closeLabel={t('closeImagePreview')}>
      <div className={css.gallery} data-align={align}>
        {attachments.map((attachment, index) => <MessageImageTile
          key={`${String(attachment.attachmentId)}:${String(index)}`}
          attachment={attachment}
          loadImage={loadImage}
          variant={variant}
          sessionId={sessionId}
          controller={controller}
          t={t}
        />)}
      </div>
    </HarnessImageGroup>
  )
}

function MessageImageTile({ attachment, loadImage, variant, sessionId, controller, t }: {
  readonly attachment: ImageAttachmentRef
  readonly loadImage: (attachment: ImageAttachmentRef) => Promise<string>
  readonly variant: 'single' | 'tile'
  readonly sessionId: string
  readonly controller: WorkbenchController
  readonly t: MessageImageGalleryProps['t']
}): ReactNode {
  const [attempt, setAttempt] = useState(0)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const source = storedImage(attachment)
  const label = attachment.name ?? t('imageUnnamed')

  useEffect(() => {
    let live = true
    setSrc(null)
    setError(false)
    void loadImage(attachment).then(value => { if (live) setSrc(value) }, () => { if (live) setError(true) })
    return () => { live = false }
  }, [attachment, attempt, loadImage])

  if (error) return (
    <button className={css.retry} data-variant={variant} type="button" onClick={() => { setAttempt(value => value + 1) }}>
      {t('imageRetryLoad')}
    </button>
  )

  const fit = variant === 'single' ? singleFit(attachment) : undefined
  return (
    <div className={css.tile} data-variant={variant} style={fit === undefined ? undefined : { width: fit.width, height: fit.height }}>
      {src === null
        ? <span className={css.loading}>{t('imageLoadingShort')}</span>
        : <HarnessImage
          rootClassName={css.preview}
          src={src}
          alt={label}
          ariaLabel={t('imageOpenNamed', { name: label })}
          width="100%"
          height="100%"
          closeLabel={t('closeImagePreview')}
          imageStyle={fit === undefined ? { objectFit: 'cover' } : { objectFit: 'cover', objectPosition: fit.objectPosition }}
          onError={() => { setError(true) }}
        />}
      <button
        className={css.edit}
        type="button"
        disabled={src === null}
        aria-label={t('imageEditNamed', { name: label })}
        title={t('imageEdit')}
        onClick={() => {
          if (src === null) return
          controller.openImage({
            sessionId,
            sourceImage: source,
            label,
            loadImage: () => loadImage(attachment),
          })
        }}
      >
        <EditGlyph />
      </button>
    </div>
  )
}

function EditGlyph(): ReactNode {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m3 11.8-.5 2.2 2.2-.5 7.8-7.8-1.7-1.7L3 11.8Z" /><path d="m9.9 4.9 1.7 1.7" /></svg>
}

function storedImage(ref: ImageAttachmentRef): StoredImageView {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

function singleFit(attachment: ImageAttachmentRef): { width: number; height: number; objectPosition: string } {
  const natural = attachment.width / attachment.height
  const ratio = Math.min(4, Math.max(.25, natural))
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 }
  const scale = Math.min(1, attachment.width / box.width, attachment.height / box.height)
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < .25 ? 'center top' : natural > 4 ? 'left center' : 'center',
  }
}

export interface ImageStudioInputBridgeInjected {
  readonly bindInserter: (
    sessionId: string,
    insert: (instruction: string, file: File) => boolean,
  ) => () => void
  readonly createDraftImages: (files: readonly File[]) => readonly ComposerAttachment[]
  readonly releaseDraftImage: (id: ComposerAttachment['id']) => void
}

export type ImageStudioInputBridgeProps =
  PropsRuntime<'conversation.input.dock'>
  & InjectFace<ImageStudioInputBridgeInjected>

export function ImageStudioInputBridge({
  sessionId, useInput, inputActions, bindInserter, createDraftImages, releaseDraftImage,
}: ImageStudioInputBridgeProps): ReactNode {
  const input = useInput(state => state)
  const inputRef = useRef(input)
  inputRef.current = input
  useEffect(() => bindInserter(String(sessionId), (instruction, file) => {
    const snapshot = inputRef.current
    if (snapshot.phase === 'adjudicating' || snapshot.phase === 'submitting') return false
    const attachment = createDraftImages([file])[0]
    if (attachment === undefined) return false
    if (!inputActions.addImages([attachment.id])) {
      releaseDraftImage(attachment.id)
      return false
    }
    try {
      inputActions.setDraft(appendInstruction(snapshot.draft, instruction))
    } catch (error) {
      inputActions.removeImage(attachment.id)
      releaseDraftImage(attachment.id)
      throw error
    }
    return true
  }), [bindInserter, createDraftImages, inputActions, releaseDraftImage, sessionId])
  return null
}

function appendInstruction(current: string, rawInstruction: string): string {
  const instruction = rawInstruction.trim()
  if (instruction.length === 0) return current
  if (current.trim().length === 0) return instruction
  return `${current.replace(/\s+$/u, '')}\n${instruction}`
}
