import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconCloseFill14, IconPaperclipOutline16, IconWarningOutline16, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { DocumentUploadRequest, DocumentUploadResult } from '@run-bigpig/dsh-desktop-plugin-host/types'
import css from './DocumentUploadBridge.module.css'

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
const DOCUMENT_ACCEPT = '.doc,.docx,.docm,.ppt,.pps,.pot,.pptx,.pptm,.ppsx,.ppsm,.xls,.xlsx,.xlsm,.xlsb,.odt,.ods,.odp,.rtf,.epub,.csv,.pdf'
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const FILE_ACCEPT = `${IMAGE_ACCEPT},${DOCUMENT_ACCEPT}`
const DOCUMENT_EXTENSIONS = new Set(DOCUMENT_ACCEPT.split(','))
const IMAGE_TYPES = new Set(IMAGE_ACCEPT.split(','))
const IMAGE_TYPE_BY_EXTENSION = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])
const DOCUMENT_MARKER = /\[Document: (.+?) \| id=(sha256:[a-f0-9]{64}) \| \d+ chars\]/u
const DOCUMENT_REFERENCE_LABEL = '\u2060'

export const DOCUMENT_REFERENCE_SOURCE = 'desktop-uploaded-document'

interface DocumentReferenceData {
  readonly id: string
  readonly name: string
  readonly marker: string
}

export interface DocumentUploadBridgeInjected {
  uploadDocument: (request: DocumentUploadRequest) => Promise<DocumentUploadResult>
  insertDocument: (document: DocumentReferenceData, span: TokenSpan) => boolean
  bindPicker: (open: () => void) => () => void
}

export type DocumentUploadBridgeProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'documents.upload'>
  & InjectFace<DocumentUploadBridgeInjected>

export interface DocumentUploadButtonInjected {
  openPicker: () => void
}

export type DocumentUploadButtonProps =
  PropsRuntime<'conversation.input.left'>
  & PropsLocale<'documents.upload'>
  & InjectFace<DocumentUploadButtonInjected>

export interface UploadBatch {
  readonly documents: readonly File[]
  readonly images: readonly File[]
  readonly oversized: readonly File[]
  readonly unsupported: readonly File[]
  readonly needsInterception: boolean
}

function DocumentDropOverlay({ disabled, title, desc }: {
  disabled: boolean
  title: string
  desc?: string | undefined
}): ReactNode {
  return createPortal(
    <div className={css.dropMask} role="status">
      <div className={css.dropContent}>
        <div className={css.dropTitle}>{title}</div>
        {!disabled && desc !== undefined && <div className={css.dropDescription}>{desc}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function classifyUploadFiles(files: readonly File[]): UploadBatch {
  const documents: File[] = []
  const images: File[] = []
  const oversized: File[] = []
  const unsupported: File[] = []
  let normalizedImage = false
  for (const file of files) {
    const extension = extensionOf(file.name)
    if (DOCUMENT_EXTENSIONS.has(extension)) {
      if (file.size > MAX_DOCUMENT_BYTES) oversized.push(file)
      else documents.push(file)
      continue
    }
    const mediaType = canonicalImageType(file, extension)
    if (mediaType !== undefined) {
      if (file.type === mediaType) images.push(file)
      else {
        images.push(new File([file], file.name, { type: mediaType, lastModified: file.lastModified }))
        normalizedImage = true
      }
      continue
    }
    unsupported.push(file)
  }
  return {
    documents,
    images,
    oversized,
    unsupported,
    needsInterception: normalizedImage || documents.length > 0 || oversized.length > 0 || unsupported.length > 0,
  }
}

export function documentReferenceOf(document: DocumentReferenceData): ReferenceInsert {
  return {
    source: DOCUMENT_REFERENCE_SOURCE,
    ref: document.marker,
    label: DOCUMENT_REFERENCE_LABEL,
    clipboardText: document.marker,
  }
}

export function DocumentUploadBridge({
  useInput, inputActions, uploadDocument, insertDocument, bindPicker, t,
}: DocumentUploadBridgeProps): ReactNode {
  const input = useInput(state => state)
  const root = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const forwardingImages = useRef(false)
  const dragDepth = useRef(0)
  const [busy, setBusy] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [pending, setPending] = useState<DocumentUploadResult[]>([])
  const [notice, setNotice] = useState<{ seq: number; kind: 'info' | 'error'; text: string } | null>(null)
  const noticeSeq = useRef(0)
  const uploadLocked = busy || input.phase === 'adjudicating' || input.phase === 'submitting'
  const documents = input.occurrences.flatMap(occurrence => {
    if (occurrence.source !== DOCUMENT_REFERENCE_SOURCE) return []
    const parsed = parseDocumentMarker(occurrence.ref)
    return parsed === undefined
      ? []
      : [{ ...parsed, offset: occurrence.offset, length: occurrence.length, occurrenceId: occurrence.occurrenceId }]
  })

  useLayoutEffect(() => {
    setAnchor(root.current?.parentElement?.querySelector<HTMLElement>('[data-composer-card]') ?? null)
  }, [documents.length])

  useLayoutEffect(() => {
    const owner = root.current?.ownerDocument
    if (owner === null || owner === undefined) return
    const occurrenceIds = new Set(documents.map(document => String(document.occurrenceId)))
    const chips = new Set<HTMLElement>()
    const hideDocumentChips = (): void => {
      for (const chip of owner.querySelectorAll<HTMLElement>('[data-decoration="chip"][data-occurrence]')) {
        if (!occurrenceIds.has(chip.dataset.occurrence ?? '')) continue
        chip.dataset.desktopDocumentChip = ''
        chips.add(chip)
      }
    }
    hideDocumentChips()
    const observer = new MutationObserver(hideDocumentChips)
    observer.observe(owner.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const chip of chips) delete chip.dataset.desktopDocumentChip
    }
  }, [documents])

  useLayoutEffect(() => {
    if (anchor === null || documents.length === 0) return
    const textarea = anchor.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea === null) return
    const boundary = Math.min(...documents.map(document => document.offset))
    const keepCaretBeforeDocuments = (): void => {
      if (textarea.selectionStart <= boundary && textarea.selectionEnd <= boundary) return
      textarea.setSelectionRange(boundary, boundary)
    }
    const frame = requestAnimationFrame(keepCaretBeforeDocuments)
    textarea.addEventListener('select', keepCaretBeforeDocuments)
    return () => {
      cancelAnimationFrame(frame)
      textarea.removeEventListener('select', keepCaretBeforeDocuments)
    }
  }, [anchor, documents])

  const showNotice = useCallback((kind: 'info' | 'error', text: string): void => {
    noticeSeq.current += 1
    setNotice({ seq: noticeSeq.current, kind, text })
  }, [])

  const forwardToNativeImageIntake = useCallback((files: readonly File[]): void => {
    if (files.length === 0) return
    if (typeof DataTransfer !== 'function' || typeof DragEvent !== 'function') {
      showNotice('error', t('imageForwardFailed'))
      return
    }
    const transfer = new DataTransfer()
    for (const file of files) transfer.items.add(file)
    forwardingImages.current = true
    try {
      document.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }))
    } finally {
      forwardingImages.current = false
    }
  }, [showNotice, t])

  const handleFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    if (files.length === 0 || uploadLocked) return
    const batch = classifyUploadFiles(files)
    forwardToNativeImageIntake(batch.images)
    if (batch.documents.length > 0) {
      setBusy(true)
      showNotice('info', t('uploading'))
      try {
        const uploaded: DocumentUploadResult[] = []
        for (const file of batch.documents) {
          uploaded.push(await uploadDocument({
            name: file.name,
            mediaType: file.type,
            base64: await fileBase64(file),
          }))
        }
        setPending(current => [...current, ...uploaded])
        showNotice('info', t('uploaded'))
      } catch (error) {
        showNotice('error', error instanceof Error && error.message.length > 0 ? error.message : t('failed'))
      } finally {
        setBusy(false)
      }
    }
    if (batch.oversized.length > 0) showNotice('error', `${t('tooLarge')} ${fileNames(batch.oversized)}`)
    if (batch.unsupported.length > 0) showNotice('error', `${t('unsupported')} ${fileNames(batch.unsupported)}`)
  }, [forwardToNativeImageIntake, showNotice, t, uploadDocument, uploadLocked])

  const openPicker = useCallback((): void => {
    if (!uploadLocked) picker.current?.click()
  }, [uploadLocked])

  useEffect(() => bindPicker(openPicker), [bindPicker, openPicker])

  useEffect(() => {
    if (uploadLocked) return
    const legacy = findDocumentMarker(input.draft)
    if (legacy !== undefined) {
      insertDocument(legacy.document, {
        start: legacy.start,
        end: legacy.end,
        draftRev: input.draftRev,
      })
      return
    }
    const next = pending[0]
    if (next === undefined) return
    if (input.occurrences.some(occurrence => occurrence.source === DOCUMENT_REFERENCE_SOURCE && occurrence.ref === next.marker)) {
      setPending(current => current.slice(1))
      return
    }
    if (insertDocument(next, {
      start: input.draft.length,
      end: input.draft.length,
      draftRev: input.draftRev,
    })) {
      setPending(current => current.slice(1))
    }
  }, [input.draft, input.draftRev, input.occurrences, insertDocument, pending, uploadLocked])

  useEffect(() => {
    const reset = (): void => {
      dragDepth.current = 0
      setDragActive(false)
    }
    const claim = (event: globalThis.DragEvent): boolean => {
      if (forwardingImages.current || !hasFiles(event.dataTransfer)) return false
      return transferNeedsDocumentBridge(event.dataTransfer)
    }
    const stop = (event: globalThis.DragEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const onDragEnter = (event: globalThis.DragEvent): void => {
      if (!claim(event)) return
      stop(event)
      dragDepth.current += 1
      setDragActive(true)
    }
    const onDragOver = (event: globalThis.DragEvent): void => {
      if (!claim(event)) return
      stop(event)
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = uploadLocked ? 'none' : 'copy'
      setDragActive(true)
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (dragDepth.current === 0 || !hasFiles(event.dataTransfer)) return
      stop(event)
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
    }
    const onDrop = (event: globalThis.DragEvent): void => {
      if (forwardingImages.current || !hasFiles(event.dataTransfer)) return
      const files = filesOf(event.dataTransfer)
      if (files.length === 0 || !classifyUploadFiles(files).needsInterception) return
      stop(event)
      reset()
      window.dispatchEvent(new Event('dragend'))
      if (!uploadLocked) void handleFiles(files)
    }
    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [handleFiles, uploadLocked])

  const removeDocument = (offset: number, length: number): void => {
    let end = offset + length
    if (input.draft[end] === ' ') end += 1
    inputActions.setDraft(input.draft.slice(0, offset) + input.draft.slice(end))
  }

  return (
    <div ref={root} className={css.dock} data-empty={documents.length === 0} data-document-upload-root="">
      <input
        ref={picker}
        className={css.hidden}
        data-document-upload-picker=""
        type="file"
        multiple
        accept={FILE_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ''
          void handleFiles(files)
        }}
      />
      {documents.length > 0 && (
        <div className={css.railPanel}>
          <div className={css.rail} role="group" aria-label={t('attachedDocuments')}>
            {documents.map(document => (
              <div className={css.document} key={document.occurrenceId} title={document.name}>
                <div className={css.thumbnail} aria-label={document.name}>
                  <span className={css.preview} aria-hidden="true">
                    <svg className={css.fileIcon} viewBox="0 0 32 38">
                      <path d="M5 1h14l8 8v24a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4Z" />
                      <path d="M19 1v8h8" />
                    </svg>
                    <span className={css.extension}>{documentExtension(document.name)}</span>
                  </span>
                  <span className={css.documentName}>{document.name}</span>
                </div>
                <button
                  className={css.remove}
                  type="button"
                  aria-label={t('removeDocument', { name: document.name })}
                  onClick={() => { removeDocument(document.offset, document.length) }}
                >
                  <IconCloseFill14 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {dragActive && (
        <DocumentDropOverlay
          disabled={uploadLocked}
          title={uploadLocked ? t('dropUnavailable') : t('dropTitle')}
          {...(uploadLocked ? {} : { desc: t('dropDescription') })}
        />
      )}
      {notice !== null && (
        <Toast
          key={notice.seq}
          text={notice.text}
          anchor={anchor}
          {...(notice.kind === 'error' ? { icon: <IconWarningOutline16 /> } : {})}
          onDone={() => { setNotice(current => current?.seq === notice.seq ? null : current) }}
        />
      )}
    </div>
  )
}

export function DocumentUploadButton({ useInput, openPicker, t }: DocumentUploadButtonProps): ReactNode {
  const disabled = useInput(input => input.phase === 'adjudicating' || input.phase === 'submitting')
  return (
    <Tooltip label={t('upload')} side="top" delayMs={500}>
      <button
        className={css.uploadButton}
        type="button"
        aria-label={t('upload')}
        data-document-upload-button=""
        disabled={disabled}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={openPicker}
      >
        <IconPaperclipOutline16 size={14} />
      </button>
    </Tooltip>
  )
}

function canonicalImageType(file: File, extension: string): string | undefined {
  const byExtension = IMAGE_TYPE_BY_EXTENSION.get(extension)
  if (byExtension !== undefined) return byExtension
  return IMAGE_TYPES.has(file.type) ? file.type : undefined
}

function transferNeedsDocumentBridge(transfer: DataTransfer | null): boolean {
  if (transfer === null) return false
  const files = filesOf(transfer)
  if (files.length > 0) return classifyUploadFiles(files).needsInterception
  return [...transfer.items].some(item => item.kind === 'file' && !IMAGE_TYPES.has(item.type))
}

function hasFiles(transfer: DataTransfer | null): boolean {
  return transfer !== null && [...transfer.types].includes('Files')
}

function filesOf(transfer: DataTransfer | null): File[] {
  if (transfer === null) return []
  const direct = [...transfer.files]
  if (direct.length > 0) return direct
  return [...transfer.items]
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index).toLocaleLowerCase()
}

function documentExtension(name: string): string {
  return extensionOf(name).slice(1).toLocaleUpperCase() || 'FILE'
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(reader.error ?? new Error('failed to read document')) }
    reader.onload = () => {
      const value = reader.result
      if (typeof value !== 'string') {
        reject(new Error('failed to encode document'))
        return
      }
      resolve(value.slice(value.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

function parseDocumentMarker(marker: string): DocumentReferenceData | undefined {
  const match = DOCUMENT_MARKER.exec(marker)
  if (match === null || match[0] !== marker || match[1] === undefined || match[2] === undefined) return undefined
  return { id: match[2], name: match[1], marker }
}

function findDocumentMarker(draft: string): { document: DocumentReferenceData; start: number; end: number } | undefined {
  const match = DOCUMENT_MARKER.exec(draft)
  if (match === null || match.index === undefined || match[1] === undefined || match[2] === undefined) return undefined
  return {
    document: { id: match[2], name: match[1], marker: match[0] },
    start: match.index,
    end: match.index + match[0].length,
  }
}

function fileNames(files: readonly File[]): string {
  return files.map(file => file.name || 'file').join('、')
}
