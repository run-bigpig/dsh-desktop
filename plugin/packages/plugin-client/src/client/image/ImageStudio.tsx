import {
  useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import {
  Button, IconEditOutline16, IconEnhanceOutline16, IconRefreshOutline16,
  IconSendOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ImageAnnotation, ImageAnnotationPoint, ImageCanvasGeometry,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { ImageStudioIntent, WorkbenchDrawerProps } from '../workbench/SessionWorkbench.tsx'
import css from './ImageStudio.module.css'

type Translate = WorkbenchDrawerProps['t']
type StudioMode = 'outpaint' | 'mark'
type PaintTool = 'brush' | 'eraser'
type ResizeHandle =
  | 'top-left' | 'top' | 'top-right' | 'right'
  | 'bottom-right' | 'bottom' | 'bottom-left' | 'left'
type LoadState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'ready'; readonly src: string }

interface Gesture {
  readonly kind: 'brush' | 'erase' | 'move' | 'resize'
  readonly pointerId: number
  readonly start: ImageAnnotationPoint
  readonly initialCanvas: ImageCanvasGeometry
  readonly initialAnnotations: readonly ImageAnnotation[]
  readonly annotationId?: string
  readonly handle?: ResizeHandle
  readonly screenToCanvas?: Pick<DOMMatrix, 'a' | 'b' | 'c' | 'd'>
}

const EXPANSIONS = [1.5, 2, 3] as const
const RESIZE_HANDLES: readonly ResizeHandle[] = [
  'top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left',
]
const MARK_COLOR = '#ff3b30'

export interface ImageStudioProps {
  readonly sessionId: string
  readonly intent: ImageStudioIntent
  readonly submitImage: (sessionId: string, instruction: string, file: File) => boolean
  readonly onReturn: () => void
  readonly t: Translate
}

export function ImageStudio({
  sessionId, intent, submitImage, onReturn, t,
}: ImageStudioProps): ReactNode {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const [mode, setMode] = useState<StudioMode>('outpaint')
  const [paintTool, setPaintTool] = useState<PaintTool>('brush')
  const [canvas, setCanvas] = useState<ImageCanvasGeometry>(() => initialCanvas(intent))
  const [annotations, setAnnotations] = useState<readonly ImageAnnotation[]>([])
  const [instruction, setInstruction] = useState('')
  const [strokeWidth, setStrokeWidth] = useState(32)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const gesture = useRef<Gesture | null>(null)

  const start = useCallback(() => {
    setLoad({ phase: 'loading' })
    setSaveError(null)
    void intent.loadImage().then(src => {
      setCanvas(initialCanvas(intent))
      setAnnotations([])
      setInstruction('')
      setLoad({ phase: 'ready', src })
    }, error => {
      setLoad({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }, [intent])

  useEffect(() => { start() }, [start])

  const pointOf = (event: ReactPointerEvent<SVGElement>): ImageAnnotationPoint | undefined => {
    const matrix = svgRef.current?.getScreenCTM()?.inverse()
    if (matrix === undefined || matrix === null) return undefined
    return {
      x: matrix.a * event.clientX + matrix.c * event.clientY + matrix.e,
      y: matrix.b * event.clientX + matrix.d * event.clientY + matrix.f,
    }
  }

  const setGeometry = (
    nextCanvas: ImageCanvasGeometry,
    nextAnnotations: readonly ImageAnnotation[],
  ): void => {
    setCanvas(nextCanvas)
    setAnnotations(nextAnnotations)
  }

  const moveSource = (
    initial: ImageCanvasGeometry,
    initialAnnotations: readonly ImageAnnotation[],
    dx: number,
    dy: number,
  ): void => {
    const next = constrainSource({
      ...initial,
      sourceX: initial.sourceX + dx,
      sourceY: initial.sourceY + dy,
    })
    setGeometry(next, translateAnnotations(
      initialAnnotations,
      next.sourceX - initial.sourceX,
      next.sourceY - initial.sourceY,
    ))
  }

  const eraseAt = (point: ImageAnnotationPoint): void => {
    setAnnotations(current => current.filter(annotation => !annotationContainsPoint(annotation, point, strokeWidth * .7)))
  }

  const beginCanvasGesture = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    const rawPoint = pointOf(event)
    if (rawPoint === undefined) return
    const point = clampPoint(rawPoint, canvas)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    if (mode === 'outpaint') {
      gesture.current = {
        kind: 'move', pointerId: event.pointerId, start: point,
        initialCanvas: canvas, initialAnnotations: annotations,
      }
      return
    }
    if (paintTool === 'eraser') {
      eraseAt(point)
      gesture.current = {
        kind: 'erase', pointerId: event.pointerId, start: point,
        initialCanvas: canvas, initialAnnotations: annotations,
      }
      return
    }
    const id = crypto.randomUUID()
    setAnnotations(current => [...current, {
      id,
      tool: 'brush',
      color: MARK_COLOR,
      strokeWidth,
      points: [point],
    }])
    gesture.current = {
      kind: 'brush', pointerId: event.pointerId, start: point,
      initialCanvas: canvas, initialAnnotations: annotations, annotationId: id,
    }
  }

  const moveCanvasGesture = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const active = gesture.current
    if (active === null || active.pointerId !== event.pointerId) return
    if (active.kind === 'resize') {
      const transform = active.screenToCanvas
      if (transform === undefined || active.handle === undefined) return
      const screenDx = event.clientX - active.start.x
      const screenDy = event.clientY - active.start.y
      resizeCanvas(
        active.initialCanvas,
        active.initialAnnotations,
        active.handle,
        transform.a * screenDx + transform.c * screenDy,
        transform.b * screenDx + transform.d * screenDy,
        setGeometry,
      )
      return
    }
    const rawPoint = pointOf(event)
    if (rawPoint === undefined) return
    const point = clampPoint(rawPoint, canvas)
    if (active.kind === 'move') {
      moveSource(
        active.initialCanvas,
        active.initialAnnotations,
        point.x - active.start.x,
        point.y - active.start.y,
      )
      return
    }
    if (active.kind === 'erase') {
      eraseAt(point)
      return
    }
    setAnnotations(current => current.map(annotation => annotation.id === active.annotationId
      ? { ...annotation, points: [...annotation.points, point] }
      : annotation))
  }

  const endGesture = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (gesture.current?.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    gesture.current = null
  }

  const beginResize = (handle: ResizeHandle) => (event: ReactPointerEvent<SVGRectElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const inverse = svgRef.current?.getScreenCTM()?.inverse()
    if (inverse === undefined || inverse === null) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    gesture.current = {
      kind: 'resize',
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      initialCanvas: canvas,
      initialAnnotations: annotations,
      handle,
      screenToCanvas: { a: inverse.a, b: inverse.b, c: inverse.c, d: inverse.d },
    }
  }

  const resizeWithKeyboard = (handle: ResizeHandle) => (event: ReactKeyboardEvent<SVGRectElement>): void => {
    const step = event.shiftKey ? 64 : 16
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (dx === 0 && dy === 0) return
    event.preventDefault()
    resizeCanvas(canvas, annotations, handle, dx, dy, setGeometry)
  }

  const nudgeSource = (event: ReactKeyboardEvent<SVGSVGElement>): void => {
    if (mode !== 'outpaint') return
    const step = event.shiftKey ? 48 : 12
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (dx === 0 && dy === 0) return
    event.preventDefault()
    moveSource(canvas, annotations, dx, dy)
  }

  const applyExpansion = (expansion: number): void => {
    const width = clampDimension(canvas.sourceWidth * expansion, canvas.sourceWidth)
    const height = clampDimension(canvas.sourceHeight * expansion, canvas.sourceHeight)
    const next = {
      ...canvas,
      width,
      height,
      sourceX: (width - canvas.sourceWidth) / 2,
      sourceY: (height - canvas.sourceHeight) / 2,
    }
    setGeometry(next, translateAnnotations(
      annotations,
      next.sourceX - canvas.sourceX,
      next.sourceY - canvas.sourceY,
    ))
  }

  const centerSource = (): void => {
    const next = {
      ...canvas,
      sourceX: (canvas.width - canvas.sourceWidth) / 2,
      sourceY: (canvas.height - canvas.sourceHeight) / 2,
    }
    setGeometry(next, translateAnnotations(
      annotations,
      next.sourceX - canvas.sourceX,
      next.sourceY - canvas.sourceY,
    ))
  }

  const reset = (): void => {
    const next = initialCanvas(intent)
    setGeometry(next, translateAnnotations(annotations, -canvas.sourceX, -canvas.sourceY))
  }

  const submit = async (): Promise<void> => {
    if (load.phase !== 'ready' || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const guide = await renderGuide(load.src, canvas, annotations)
      const file = new File([guide], 'image-studio-guide.png', { type: 'image/png' })
      if (!submitImage(sessionId, instruction.trim(), file)) throw new Error(t('imageInsertFailed'))
      onReturn()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  if (load.phase === 'loading') return <StudioStatus title={t('imageLoading')} description={t('imageLoadingHint')} />
  if (load.phase === 'error') return (
    <StudioStatus
      title={t('imageLoadFailed')}
      description={load.message}
      action={<Button variant="primary" onClick={start}>{t('retry')}</Button>}
    />
  )

  const maxDimension = Math.max(canvas.width, canvas.height)
  const handleSize = Math.max(18, Math.min(44, maxDimension * .024))
  const canvasPadding = handleSize * 1.6

  return (
    <div className={css.studio}>
      <main className={css.editor}>
        <div className={css.editorHeader}>
          <div className={css.modeSwitch} role="tablist" aria-label={t('imageModes')}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'outpaint'}
              data-active={mode === 'outpaint' || undefined}
              onClick={() => { setMode('outpaint') }}
            >
              <IconEnhanceOutline16 />
              {t('imageModeOutpaint')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'mark'}
              data-active={mode === 'mark' || undefined}
              onClick={() => { setMode('mark') }}
            >
              <IconEditOutline16 />
              {t('imageModeMark')}
            </button>
          </div>
          <span className={css.canvasReadout}>{Math.round(canvas.width)} × {Math.round(canvas.height)} px</span>
        </div>

        <div className={css.canvasShell} data-mode={mode}>
          <svg
            ref={svgRef}
            className={css.canvas}
            data-mode={mode}
            data-paint-tool={paintTool}
            viewBox={`${String(-canvasPadding)} ${String(-canvasPadding)} ${String(canvas.width + canvasPadding * 2)} ${String(canvas.height + canvasPadding * 2)}`}
            role="application"
            tabIndex={0}
            aria-label={t('imageCanvas')}
            onPointerDown={beginCanvasGesture}
            onPointerMove={moveCanvasGesture}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onKeyDown={nudgeSource}
          >
            <defs>
              <pattern id="dsh-image-checker" width="24" height="24" patternUnits="userSpaceOnUse">
                <rect className={css.checkerBase} width="24" height="24" />
                <path className={css.checkerTile} d="M0 0h12v12H0zM12 12h12v12H12z" />
              </pattern>
              <marker id="dsh-image-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0 0L9 3L0 6z" fill="context-stroke" />
              </marker>
            </defs>
            <rect className={css.canvasBoundary} width={canvas.width} height={canvas.height} fill="url(#dsh-image-checker)" />
            <image
              href={load.src}
              x={canvas.sourceX}
              y={canvas.sourceY}
              width={canvas.sourceWidth}
              height={canvas.sourceHeight}
              preserveAspectRatio="none"
            />
            {mode === 'outpaint' && (
              <rect
                className={css.sourceBoundary}
                x={canvas.sourceX}
                y={canvas.sourceY}
                width={canvas.sourceWidth}
                height={canvas.sourceHeight}
              />
            )}
            {annotations.map(annotation => <AnnotationView key={annotation.id} annotation={annotation} />)}
            {mode === 'outpaint' && RESIZE_HANDLES.map(handle => (
              <ResizeHandleView
                key={handle}
                handle={handle}
                canvas={canvas}
                size={handleSize}
                label={`${t('imageResizeHandle')} ${handle}`}
                onPointerDown={beginResize(handle)}
                onKeyDown={resizeWithKeyboard(handle)}
              />
            ))}
          </svg>
          <p className={css.canvasHint}>{mode === 'outpaint' ? t('imageOutpaintHint') : t('imageMarkHint')}</p>
        </div>

        <div className={css.floatingToolbar} aria-label={mode === 'outpaint' ? t('imageOutpaintTools') : t('imageMarkTools')}>
          {mode === 'outpaint' ? (
            <>
              <span className={css.toolbarLabel}>{t('imageExpansion')}</span>
              {EXPANSIONS.map(expansion => (
                <Button key={expansion} variant="toolbar" size="sm" onClick={() => { applyExpansion(expansion) }}>
                  {expansion}×
                </Button>
              ))}
              <span className={css.toolbarDivider} />
              <Button variant="ghost" size="sm" onClick={centerSource}>{t('imageCenter')}</Button>
              <Button variant="ghost" size="sm" icon={<IconRefreshOutline16 />} onClick={reset}>{t('imageReset')}</Button>
            </>
          ) : (
            <>
              <Button
                variant={paintTool === 'brush' ? 'toolbar' : 'ghost'}
                size="sm"
                icon={<IconEditOutline16 />}
                aria-pressed={paintTool === 'brush'}
                onClick={() => { setPaintTool('brush') }}
              >
                {t('imageBrush')}
              </Button>
              <Button
                variant={paintTool === 'eraser' ? 'toolbar' : 'ghost'}
                size="sm"
                aria-pressed={paintTool === 'eraser'}
                onClick={() => { setPaintTool('eraser') }}
              >
                {t('imageEraser')}
              </Button>
              <span className={css.markColor} aria-label={t('imageFixedRed')} />
              <label className={css.brushSize}>
                <span>{t('imageStroke')}</span>
                <input
                  type="range"
                  min="6"
                  max="96"
                  value={strokeWidth}
                  aria-label={t('imageStroke')}
                  onChange={event => { setStrokeWidth(Number(event.target.value)) }}
                />
              </label>
              <span className={css.toolbarDivider} />
              <Button
                variant="ghost"
                size="sm"
                disabled={annotations.length === 0}
                onClick={() => { setAnnotations(current => current.slice(0, -1)) }}
              >
                {t('imageUndo')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<IconTrashOutline16 />}
                disabled={annotations.length === 0}
                onClick={() => { setAnnotations([]) }}
              >
                {t('imageClear')}
              </Button>
            </>
          )}
        </div>
      </main>

      <aside className={css.sidePanel}>
        <section className={css.summaryCard}>
          <span className={css.cardEyebrow}>{mode === 'outpaint' ? t('imageModeOutpaint') : t('imageModeMark')}</span>
          <strong>{mode === 'outpaint' ? t('imageOutpaintTitle') : t('imageMarkTitle')}</strong>
          <p>{mode === 'outpaint' ? t('imageOutpaintDescription') : t('imageMarkDescription')}</p>
          <dl>
            <div><dt>{t('imageCanvasSize')}</dt><dd>{Math.round(canvas.width)} × {Math.round(canvas.height)}</dd></div>
            <div><dt>{t('imageMarks')}</dt><dd>{annotations.length}</dd></div>
          </dl>
        </section>

        <section className={css.promptSection}>
          <label htmlFor="dsh-image-instruction">{t('imageInstruction')}</label>
          <textarea
            id="dsh-image-instruction"
            rows={6}
            value={instruction}
            placeholder={t('imageInstructionPlaceholder')}
            onChange={event => { setInstruction(event.target.value) }}
          />
          <p>{t('imageInstructionHint')}</p>
          {saveError !== null && <p className={css.error} role="alert">{saveError}</p>}
        </section>

        <footer className={css.submitActions}>
          <Button
            variant="primary"
            icon={<IconSendOutline16 />}
            disabled={saving || instruction.trim().length === 0}
            onClick={() => { void submit() }}
          >
            {saving ? t('imageSending') : t('imageSendAgent')}
          </Button>
        </footer>
      </aside>
    </div>
  )
}

function initialCanvas(intent: ImageStudioIntent): ImageCanvasGeometry {
  return {
    width: intent.sourceImage.width,
    height: intent.sourceImage.height,
    sourceX: 0,
    sourceY: 0,
    sourceWidth: intent.sourceImage.width,
    sourceHeight: intent.sourceImage.height,
  }
}

function ResizeHandleView({
  handle, canvas, size, label, onPointerDown, onKeyDown,
}: {
  readonly handle: ResizeHandle
  readonly canvas: ImageCanvasGeometry
  readonly size: number
  readonly label: string
  readonly onPointerDown: (event: ReactPointerEvent<SVGRectElement>) => void
  readonly onKeyDown: (event: ReactKeyboardEvent<SVGRectElement>) => void
}): ReactNode {
  const centerX = handle.includes('left') ? 0 : handle.includes('right') ? canvas.width : canvas.width / 2
  const centerY = handle.includes('top') ? 0 : handle.includes('bottom') ? canvas.height : canvas.height / 2
  return (
    <rect
      className={css.resizeHandle}
      data-handle={handle}
      x={centerX - size / 2}
      y={centerY - size / 2}
      width={size}
      height={size}
      rx={size * .18}
      role="button"
      tabIndex={0}
      aria-label={label}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}

function resizeCanvas(
  initial: ImageCanvasGeometry,
  initialAnnotations: readonly ImageAnnotation[],
  handle: ResizeHandle,
  dx: number,
  dy: number,
  apply: (canvas: ImageCanvasGeometry, annotations: readonly ImageAnnotation[]) => void,
): void {
  const left = handle.includes('left')
  const right = handle.includes('right')
  const top = handle.includes('top')
  const bottom = handle.includes('bottom')
  const rightGap = Math.max(0, initial.width - initial.sourceX - initial.sourceWidth)
  const bottomGap = Math.max(0, initial.height - initial.sourceY - initial.sourceHeight)
  const width = left
    ? clampDimension(initial.width - dx, initial.sourceWidth + rightGap)
    : right ? clampDimension(initial.width + dx, initial.sourceX + initial.sourceWidth) : initial.width
  const height = top
    ? clampDimension(initial.height - dy, initial.sourceHeight + bottomGap)
    : bottom ? clampDimension(initial.height + dy, initial.sourceY + initial.sourceHeight) : initial.height
  const resized = constrainSource({
    ...initial,
    width,
    height,
    sourceX: initial.sourceX + (left ? width - initial.width : 0),
    sourceY: initial.sourceY + (top ? height - initial.height : 0),
  })
  apply(resized, translateAnnotations(
    initialAnnotations,
    resized.sourceX - initial.sourceX,
    resized.sourceY - initial.sourceY,
  ))
}

function constrainSource(canvas: ImageCanvasGeometry): ImageCanvasGeometry {
  return {
    ...canvas,
    sourceX: clampNumber(canvas.sourceX, Math.min(0, canvas.width - canvas.sourceWidth), Math.max(0, canvas.width - canvas.sourceWidth)),
    sourceY: clampNumber(canvas.sourceY, Math.min(0, canvas.height - canvas.sourceHeight), Math.max(0, canvas.height - canvas.sourceHeight)),
  }
}

function translateAnnotations(
  annotations: readonly ImageAnnotation[],
  dx: number,
  dy: number,
): readonly ImageAnnotation[] {
  if (dx === 0 && dy === 0) return annotations
  return annotations.map(annotation => ({
    ...annotation,
    points: annotation.points.map(point => ({ x: point.x + dx, y: point.y + dy })),
  }))
}

function clampPoint(point: ImageAnnotationPoint, canvas: ImageCanvasGeometry): ImageAnnotationPoint {
  return {
    x: clampNumber(point.x, 0, canvas.width),
    y: clampNumber(point.y, 0, canvas.height),
  }
}

function annotationContainsPoint(
  annotation: ImageAnnotation,
  point: ImageAnnotationPoint,
  radius: number,
): boolean {
  const points = annotation.points
  if (points.length === 0) return false
  const hitRadius = radius + annotation.strokeWidth / 2
  if (points.length === 1) return distance(points[0]!, point) <= hitRadius
  for (let index = 1; index < points.length; index += 1) {
    if (distanceToSegment(point, points[index - 1]!, points[index]!) <= hitRadius) return true
  }
  return false
}

function distanceToSegment(point: ImageAnnotationPoint, start: ImageAnnotationPoint, end: ImageAnnotationPoint): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return distance(point, start)
  const position = clampNumber(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1)
  return distance(point, { x: start.x + position * dx, y: start.y + position * dy })
}

function distance(first: ImageAnnotationPoint, second: ImageAnnotationPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

function AnnotationView({ annotation }: { readonly annotation: ImageAnnotation }): ReactNode {
  const first = annotation.points[0]
  const last = annotation.points.at(-1)
  if (first === undefined || last === undefined) return null
  const common = { stroke: annotation.color, strokeWidth: annotation.strokeWidth, fill: 'none' }
  switch (annotation.tool) {
    case 'rectangle':
      return <rect {...common} x={Math.min(first.x, last.x)} y={Math.min(first.y, last.y)} width={Math.abs(last.x - first.x)} height={Math.abs(last.y - first.y)} />
    case 'ellipse':
      return <ellipse {...common} cx={(first.x + last.x) / 2} cy={(first.y + last.y) / 2} rx={Math.abs(last.x - first.x) / 2} ry={Math.abs(last.y - first.y) / 2} />
    case 'brush':
    case 'highlight':
      return annotation.points.length === 1
        ? <circle cx={first.x} cy={first.y} r={annotation.strokeWidth / 2} fill={annotation.color} opacity={annotation.tool === 'highlight' ? .42 : 1} />
        : <polyline {...common} opacity={annotation.tool === 'highlight' ? .42 : 1} strokeLinecap="round" strokeLinejoin="round" points={annotation.points.map(point => `${point.x},${point.y}`).join(' ')} />
    case 'arrow':
    case 'extension':
      return <line {...common} strokeDasharray={annotation.tool === 'extension' ? '16 10' : undefined} markerEnd="url(#dsh-image-arrow)" x1={first.x} y1={first.y} x2={last.x} y2={last.y} />
    case 'text':
      return <text x={first.x} y={first.y} fill={annotation.color} fontSize={Math.max(24, annotation.strokeWidth * 5)} fontWeight="700">{annotation.text}</text>
    case 'cross':
      return <g {...common}><line x1={first.x} y1={first.y} x2={last.x} y2={last.y} /><line x1={last.x} y1={first.y} x2={first.x} y2={last.y} /></g>
  }
}

function StudioStatus({ title, description, action }: { readonly title: string; readonly description: string; readonly action?: ReactNode }): ReactNode {
  return <div className={css.status}><span className={css.statusMark}>◫</span><strong>{title}</strong><p>{description}</p>{action}</div>
}

async function renderGuide(
  src: string,
  geometry: ImageCanvasGeometry,
  annotations: readonly ImageAnnotation[],
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(geometry.width)
  canvas.height = Math.round(geometry.height)
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Image Studio could not create a drawing surface')
  const image = await loadBrowserImage(src)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, geometry.sourceX, geometry.sourceY, geometry.sourceWidth, geometry.sourceHeight)
  for (const annotation of annotations) drawAnnotation(context, annotation)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => { if (value === null) reject(new Error('Image Studio could not encode the guide')); else resolve(value) }, 'image/png')
  })
  return blob
}

function drawAnnotation(context: CanvasRenderingContext2D, annotation: ImageAnnotation): void {
  const first = annotation.points[0]
  const last = annotation.points.at(-1)
  if (first === undefined || last === undefined) return
  context.save()
  context.strokeStyle = annotation.color
  context.fillStyle = annotation.color
  context.lineWidth = annotation.strokeWidth
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (annotation.tool === 'highlight') context.globalAlpha = .42
  context.beginPath()
  switch (annotation.tool) {
    case 'rectangle': context.strokeRect(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.abs(last.x - first.x), Math.abs(last.y - first.y)); break
    case 'ellipse': context.ellipse((first.x + last.x) / 2, (first.y + last.y) / 2, Math.abs(last.x - first.x) / 2, Math.abs(last.y - first.y) / 2, 0, 0, Math.PI * 2); context.stroke(); break
    case 'brush':
    case 'highlight':
      if (annotation.points.length === 1) {
        context.arc(first.x, first.y, annotation.strokeWidth / 2, 0, Math.PI * 2)
        context.fill()
      } else {
        context.moveTo(first.x, first.y)
        for (const point of annotation.points.slice(1)) context.lineTo(point.x, point.y)
        context.stroke()
      }
      break
    case 'arrow':
    case 'extension': drawArrow(context, first, last, annotation.tool === 'extension'); break
    case 'text': context.font = `700 ${Math.max(24, annotation.strokeWidth * 5)}px sans-serif`; context.fillText(annotation.text ?? '', first.x, first.y); break
    case 'cross': context.moveTo(first.x, first.y); context.lineTo(last.x, last.y); context.moveTo(last.x, first.y); context.lineTo(first.x, last.y); context.stroke(); break
  }
  context.restore()
}

function drawArrow(context: CanvasRenderingContext2D, first: ImageAnnotationPoint, last: ImageAnnotationPoint, dashed: boolean): void {
  if (dashed) context.setLineDash([16, 10])
  context.moveTo(first.x, first.y)
  context.lineTo(last.x, last.y)
  context.stroke()
  context.setLineDash([])
  const angle = Math.atan2(last.y - first.y, last.x - first.x)
  const head = Math.max(18, context.lineWidth * 3)
  context.beginPath()
  context.moveTo(last.x, last.y)
  context.lineTo(last.x - head * Math.cos(angle - Math.PI / 6), last.y - head * Math.sin(angle - Math.PI / 6))
  context.lineTo(last.x - head * Math.cos(angle + Math.PI / 6), last.y - head * Math.sin(angle + Math.PI / 6))
  context.closePath()
  context.fill()
}

function loadBrowserImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { resolve(image) }
    image.onerror = () => { reject(new Error('Image Studio could not read the source image')) }
    image.src = src
  })
}

function clampDimension(value: number, minimum = 64): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(8192, Math.max(minimum, Math.round(value)))
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
