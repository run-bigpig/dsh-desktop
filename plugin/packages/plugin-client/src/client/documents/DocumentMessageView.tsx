import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconCheckOutline16, IconCopyOutline16, JsonBlock, MessageText, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { InjectFace, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageImageSource, MessageImagesOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import css from './DocumentMessageView.module.css'

const DOCUMENT_MARKER_SOURCE = String.raw`\[Document: (.+?) \| id=(sha256:[a-f0-9]{64}) \| \d+ chars\]`

export interface MessageDocument {
  readonly id: string
  readonly name: string
  readonly marker: string
}

export interface DocumentMessageInjected {
  documentT: TranslateNS<'documents.upload'>
}

export type DocumentUserMessageProps =
  ChatNodeViewProps<'user'>
  & InjectFace<DocumentMessageInjected>

export type DocumentSteeringMessageProps =
  ChatNodeViewProps<'steering'>
  & InjectFace<DocumentMessageInjected>

export type DocumentMessageProps = DocumentUserMessageProps | DocumentSteeringMessageProps

export function extractDocumentMessage(text: string): { readonly text: string; readonly documents: readonly MessageDocument[] } {
  const documents = [...text.matchAll(new RegExp(DOCUMENT_MARKER_SOURCE, 'gu'))].flatMap(match => {
    const name = match[1]
    const id = match[2]
    return name === undefined || id === undefined ? [] : [{ id, name, marker: match[0] }]
  })
  const visible = text
    .replace(new RegExp(DOCUMENT_MARKER_SOURCE, 'gu'), '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return { text: visible, documents }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index < 0 ? 'FILE' : name.slice(index + 1).toLocaleUpperCase() || 'FILE'
}

function contentParts(content: readonly unknown[]): {
  readonly text: string
  readonly images: MessageImagesOwnerProps['images']
  readonly rest: readonly unknown[]
} {
  const texts: string[] = []
  const images: MessageImageSource[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const candidate = block as {
      type?: string
      text?: string
      attachment?: ImageAttachmentRef
    }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
    else if (candidate.type === 'image' && candidate.attachment !== undefined) images.push({ attachment: candidate.attachment })
    else rest.push(block)
  }
  return { text: texts.join(''), images, rest }
}

function projectUserText(text: string): ReactNode {
  const reference = /(^|\s)([/@][\w-]+)(?=\s|$)/gu
  const parts: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = reference.exec(text)) !== null) {
    const tokenStart = match.index + (match[1]?.length ?? 0)
    const label = match[2] ?? ''
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    parts.push(
      <span key={tokenStart} className={css.refChip} data-ref-chip={label.startsWith('@') ? 'subagent' : 'skill'}>
        {label}
      </span>,
    )
    cursor = tokenStart + label.length
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

function messageClock(time: number): string {
  const date = new Date(time)
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(date)
}

function MessageActions({ text, time, t }: { text: string; time: number; t: DocumentMessageProps['t'] }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const copy = useCallback(() => {
    if (copied) return
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      timer.current = window.setTimeout(() => {
        timer.current = null
        setCopied(false)
      }, 1000)
    })
  }, [copied, text])
  return (
    <div className={css.actions}>
      <span className={css.time}>{messageClock(time)}</span>
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button className={css.copy} type="button" aria-label={copied ? t('copied') : t('copy')} onClick={copy}>
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        </button>
      </Tooltip>
    </div>
  )
}

function DocumentCards({ documents, label }: { documents: readonly MessageDocument[]; label: string }): ReactNode {
  if (documents.length === 0) return null
  return (
    <div className={css.documents} role="group" aria-label={label}>
      {documents.map((document, index) => (
        <div className={css.document} key={`${document.id}:${index}`} title={document.name} data-document-message-attachment="">
          <span className={css.preview} aria-hidden="true">
            <svg className={css.fileIcon} viewBox="0 0 32 38">
              <path d="M5 1h14l8 8v24a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4Z" />
              <path d="M19 1v8h8" />
            </svg>
            <span className={css.extension}>{extensionOf(document.name)}</span>
          </span>
          <span className={css.documentName}>{document.name}</span>
        </div>
      ))}
    </div>
  )
}

function renderDocumentMessage({
  node, renderMessageImages, t, documentT,
}: DocumentMessageProps): ReactNode {
  const data = node.data
  const content = contentParts(data.content)
  const projected = extractDocumentMessage(content.text)
  const showBubble = projected.text !== '' || content.rest.length > 0
  return (
    <div className={css.userRow} data-time-hover-root>
      <div className={css.userStack}>
        {renderMessageImages({ images: content.images, align: 'end' })}
        <DocumentCards documents={projected.documents} label={documentT('sentDocuments')} />
        {showBubble && (
          <div className={css.bubble}>
            {projectUserText(projected.text)}
            {content.rest.map((block, index) => (
              <JsonBlock
                key={index}
                label={t('message.extraBlock')}
                payload={block}
                truncatedLabel={total => t('json.truncated', { total })}
              />
            ))}
          </div>
        )}
      </div>
      <MessageActions text={content.text} time={data.time} t={t} />
    </div>
  )
}

export const DocumentMessageView = memo(renderDocumentMessage)

export const DocumentUserMessageView = memo(function DocumentUserMessageView(props: DocumentUserMessageProps): ReactNode {
  return renderDocumentMessage(props)
})

export const DocumentSteeringMessageView = memo(function DocumentSteeringMessageView(props: DocumentSteeringMessageProps): ReactNode {
  return renderDocumentMessage(props)
})
