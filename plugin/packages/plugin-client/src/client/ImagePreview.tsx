import Image from '@rc-component/image/es/Image.js'
import PreviewGroup from '@rc-component/image/es/PreviewGroup.js'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import css from './ImagePreview.module.css'

const IMAGE_PREFIX = 'dsh-image'
const PREVIEW_PREFIX = 'dsh-image-preview'

export interface HarnessImageProps {
  readonly src: string
  readonly alt: string
  readonly ariaLabel?: string | undefined
  readonly width?: number | string | undefined
  readonly height?: number | string | undefined
  readonly rootClassName?: string | undefined
  readonly imageClassName?: string | undefined
  readonly imageStyle?: CSSProperties | undefined
  readonly placeholder?: ReactNode | undefined
  readonly preview?: boolean | undefined
  readonly closeLabel: string
  readonly onError?: (() => void) | undefined
}

export function HarnessImage({
  src, alt, ariaLabel, width, height, rootClassName, imageClassName, imageStyle,
  placeholder, preview = true, closeLabel, onError,
}: HarnessImageProps): ReactNode {
  return (
    <Image
      prefixCls={IMAGE_PREFIX}
      previewPrefixCls={PREVIEW_PREFIX}
      src={src}
      alt={alt}
      classNames={{ root: classes(css.root, rootClassName), image: classes(css.image, imageClassName) }}
      preview={preview ? { cover: false, motionName: '', closeIcon: closeIcon(closeLabel), icons: previewIcons() } : false}
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
      {...(width === undefined ? {} : { width })}
      {...(height === undefined ? {} : { height })}
      {...(imageStyle === undefined ? {} : { style: imageStyle })}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...(onError === undefined ? {} : { onError: () => { onError() } })}
    />
  )
}

export function HarnessImageGroup({ children, label, closeLabel }: {
  readonly children: ReactNode
  readonly label: string
  readonly closeLabel: string
}): ReactNode {
  return (
    <PreviewGroup
      previewPrefixCls={PREVIEW_PREFIX}
      icons={previewIcons()}
      preview={{ alt: label, motionName: '', closeIcon: closeIcon(closeLabel) }}
    >
      {children}
    </PreviewGroup>
  )
}

function closeIcon(label: string): ReactNode {
  return <><IconCloseOutline16 /><span className={css.visuallyHidden}>{label}</span></>
}

function previewIcons(): {
  readonly close: ReactNode
  readonly prev: ReactNode
  readonly next: ReactNode
  readonly flipX: ReactNode
  readonly flipY: ReactNode
  readonly rotateLeft: ReactNode
  readonly rotateRight: ReactNode
  readonly zoomOut: ReactNode
  readonly zoomIn: ReactNode
} {
  return {
    close: <IconCloseOutline16 />,
    prev: <IconChevronLeftOutline14 />,
    next: <IconChevronRightOutline14 />,
    flipX: <OperationGlyph kind="flip-x" />,
    flipY: <OperationGlyph kind="flip-y" />,
    rotateLeft: <OperationGlyph kind="rotate-left" />,
    rotateRight: <OperationGlyph kind="rotate-right" />,
    zoomOut: <OperationGlyph kind="zoom-out" />,
    zoomIn: <OperationGlyph kind="zoom-in" />,
  }
}

function OperationGlyph({ kind }: {
  readonly kind: 'flip-x' | 'flip-y' | 'rotate-left' | 'rotate-right' | 'zoom-out' | 'zoom-in'
}): ReactNode {
  if (kind === 'zoom-out' || kind === 'zoom-in') return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.2 10.2 3.1 3.1M4.8 7h4.4" />
      {kind === 'zoom-in' && <path d="M7 4.8v4.4" />}
    </svg>
  )
  if (kind === 'flip-x' || kind === 'flip-y') return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d={kind === 'flip-x' ? 'M8 2v12M6 4 2.5 8 6 12M10 4l3.5 4-3.5 4' : 'M2 8h12M4 6l4-3.5L12 6M4 10l4 3.5 4-3.5'} />
    </svg>
  )
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d={kind === 'rotate-left' ? 'M5 4H2v-3M2.5 4.2A6 6 0 1 1 2 10' : 'M11 4h3v-3M13.5 4.2A6 6 0 1 0 14 10'} />
    </svg>
  )
}

function classes(...values: readonly (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined && value.length > 0).join(' ')
}
