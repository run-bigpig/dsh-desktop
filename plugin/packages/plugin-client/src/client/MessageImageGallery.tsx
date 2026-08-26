import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ComposerAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconCloseOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StoredImageView } from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { WorkbenchController } from './SessionWorkbench.tsx'
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
  readonly images: readonly { readonly attachment: ImageAttachmentRef }[]
  readonly loadImage: (attachment: ImageAttachmentRef) => Promise<string>
  readonly align: 'start' | 'end'
  readonly sessionId: string
  readonly controller: WorkbenchController
  readonly t: MessageImageGalleryProps['t']
}

export function MessageImageTiles({
  images, loadImage, align, sessionId, controller, t,
}: MessageImageTilesProps): ReactNode {
  if (images.length === 0) return null
  const variant = images.length === 1 ? 'single' : 'tile'
  return (
    <div className={css.gallery} data-align={align}>
      {images.map((image, index) => (
        <MessageImageTile
          key={`${String(image.attachment.attachmentId)}:${String(index)}`}
          attachment={image.attachment}
          loadImage={loadImage}
          variant={variant}
          sessionId={sessionId}
          controller={controller}
          t={t}
        />
      ))}
    </div>
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
  const [lightbox, setLightbox] = useState(false)
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
    <>
      <div className={css.tile} data-variant={variant} style={fit === undefined ? undefined : { width: fit.width, height: fit.height }}>
        <button
          className={css.preview}
          type="button"
          aria-label={t('imageOpenNamed', { name: label })}
          onClick={() => { if (src !== null) setLightbox(true) }}
        >
          {src === null
            ? <span className={css.loading}>{t('imageLoadingShort')}</span>
            : <img src={src} alt={label} style={fit === undefined ? undefined : { objectPosition: fit.objectPosition }} />}
        </button>
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
      {lightbox && src !== null && <ImageLightbox src={src} label={label} onClose={() => { setLightbox(false) }} t={t} />}
    </>
  )
}

function ImageLightbox({ src, label, onClose, t }: {
  readonly src: string
  readonly label: string
  readonly onClose: () => void
  readonly t: MessageImageGalleryProps['t']
}): ReactNode {
  return (
    <Modal
      open
      headless
      title={t('imagePreview')}
      closeLabel={t('close')}
      className={css.lightboxDialog ?? ''}
      onClose={onClose}
    >
      <div className={css.lightboxContent}>
        <img src={src} alt={label} />
        <button className={css.lightboxClose} type="button" aria-label={t('close')} onClick={onClose}>
          <IconCloseOutline16 />
        </button>
      </div>
    </Modal>
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
