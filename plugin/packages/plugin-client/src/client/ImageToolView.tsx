import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { MessageImageTiles } from './MessageImageGallery.tsx'
import type { WorkbenchController } from './SessionWorkbench.tsx'
import css from './ImageToolView.module.css'

export interface ImageToolViewInjected {
  readonly loadImage: (sessionId: string, attachment: ImageAttachmentRef) => Promise<string>
  readonly controller: WorkbenchController
}

export type ImageToolViewProps =
  ToolCallViewProps
  & PropsLocale<'desktop.workbench'>
  & InjectFace<ImageToolViewInjected>

interface ToolModel {
  readonly phase: 'running' | 'ready' | 'error'
  readonly title: string
  readonly summary: string
  readonly taskId?: string
  readonly model?: string
  readonly dimensions?: string
  readonly error?: string
  readonly args: string
}

export function ImageToolView({
  toolName, block, inspect, sessionId, loadImage, controller, t,
}: ImageToolViewProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const model = useMemo(() => toolModel(toolName, block, t), [block, t, toolName])
  const images = useMemo(() => resultImages(block), [block])
  const imageLoader = useCallback(
    (attachment: ImageAttachmentRef) => loadImage(String(sessionId), attachment),
    [loadImage, sessionId],
  )
  const visualLoading = model.phase === 'running' && isImageRenderTool(toolName)

  return (
    <section
      className={css.card}
      data-phase={model.phase}
      data-expanded={expanded || undefined}
      data-loading={visualLoading || undefined}
    >
      <header>
        <button type="button" aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>
          <span className={css.icon}><ImageGlyph /></span>
          <span className={css.heading}><strong>{model.title}</strong><span>{model.summary}</span></span>
          <span className={css.state} aria-hidden="true" />
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
        {inspect !== undefined && <button className={css.inspect} type="button" onClick={inspect}>{t('imageInspect')}</button>}
      </header>
      {visualLoading && (
        <div className={css.generating} role="status" aria-live="polite">
          <div className={css.developingFrame} aria-hidden="true">
            <span className={css.developingSun} />
            <span className={css.developingRidgeBack} />
            <span className={css.developingRidgeFront} />
            <span className={css.developingScan} />
          </div>
          <div className={css.generatingCopy}>
            <span className={css.generatingLabel}><i />{t('imageDeveloping')}</span>
            <p>{model.summary}</p>
            <span className={css.progressTrack} aria-hidden="true"><i /></span>
            <small>{t('imageGeneratingHint')}</small>
          </div>
        </div>
      )}
      {model.phase === 'ready' && images.length > 0 && (
        <div className={css.resultImages}>
          <MessageImageTiles
            images={images}
            loadImage={imageLoader}
            align="start"
            sessionId={String(sessionId)}
            controller={controller}
            t={t}
          />
        </div>
      )}
      {expanded && (
        <div className={css.body}>
          {model.error !== undefined && <p className={css.error}>{model.error}</p>}
          <dl>
            {model.taskId !== undefined && <><dt>{t('imageTaskId')}</dt><dd>{model.taskId}</dd></>}
            {model.model !== undefined && <><dt>{t('imageModel')}</dt><dd>{model.model}</dd></>}
            {model.dimensions !== undefined && <><dt>{t('imageDimensions')}</dt><dd>{model.dimensions}</dd></>}
          </dl>
          <details>
            <summary>{t('imageRequest')}</summary>
            <pre>{model.args}</pre>
          </details>
        </div>
      )}
    </section>
  )
}

function resultImages(block: ImageToolViewProps['block']): { attachment: ImageAttachmentRef }[] {
  if (!('kind' in block)) return []
  return block.content.flatMap(content => content.type === 'image' ? [{ attachment: content.attachment }] : [])
}

function isImageRenderTool(toolName: string): boolean {
  return toolName === 'image_generate' || toolName === 'image_edit' || toolName === 'image_task_continue'
}

function toolModel(toolName: string, block: ImageToolViewProps['block'], t: ImageToolViewProps['t']): ToolModel {
  const argsRaw = 'kind' in block ? block.call?.argsRaw ?? '{}' : block.argsRaw
  const args = recordOf(parseJson(argsRaw))
  const title = titleOf(toolName, t)
  if (!('kind' in block)) return {
    phase: 'running',
    title,
    summary: runningSummaryOf(toolName, args, t),
    args: pretty(argsRaw),
  }
  const text = block.content.flatMap(content => content.type === 'text' ? [content.text] : []).join('\n')
  const result = recordOf(parseJson(text))
  const images = block.content.filter(content => content.type === 'image')
  if (block.isError) return {
    phase: 'error',
    title,
    summary: t('imageFailed'),
    error: text.trim() || block.error?.code || t('imageUnknownError'),
    args: pretty(argsRaw),
  }
  const metadata = taskMetadata(result)
  const dimensions = imageDimensions(images)
  const failures = batchFailures(result)
  return {
    phase: 'ready',
    title,
    summary: readySummaryOf(toolName, args, result, t),
    ...metadata,
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(failures.length === 0 ? {} : { error: failures.join('\n') }),
    args: pretty(argsRaw),
  }
}

function titleOf(toolName: string, t: ImageToolViewProps['t']): string {
  switch (toolName) {
    case 'image_generate': return t('imageToolGenerate')
    case 'image_edit': return t('imageToolEdit')
    case 'image_task_continue': return t('imageToolContinue')
    case 'image_task_get': return t('imageToolGet')
    case 'image_versions': return t('imageToolVersions')
    default: return t('imageStudio')
  }
}

function runningSummaryOf(
  toolName: string,
  args: Record<string, unknown> | undefined,
  t: ImageToolViewProps['t'],
): string {
  if (toolName === 'image_generate' && Array.isArray(args?.prompts)) {
    return t('imageGeneratingMany', { count: args.prompts.length })
  }
  return summaryOf(toolName, args, t('imageWorking'))
}

function readySummaryOf(
  toolName: string,
  args: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
  t: ImageToolViewProps['t'],
): string {
  if (toolName === 'image_generate' && typeof result?.completed === 'number') {
    const failed = typeof result.failed === 'number' ? result.failed : 0
    return failed === 0
      ? t('imageGeneratedMany', { count: result.completed })
      : t('imageGeneratedPartial', { completed: result.completed, failed })
  }
  return summaryOf(toolName, args, t('imageCompleted'))
}

function summaryOf(toolName: string, args: Record<string, unknown> | undefined, fallback: string): string {
  if (toolName === 'image_generate' && typeof args?.prompt === 'string') return firstLine(args.prompt)
  if ((toolName === 'image_edit' || toolName === 'image_task_continue') && typeof args?.instruction === 'string') return firstLine(args.instruction)
  if (typeof args?.task_id === 'string') return args.task_id
  return fallback
}

function taskMetadata(result: Record<string, unknown> | undefined): Pick<ToolModel, 'taskId' | 'model'> {
  if (typeof result?.taskId === 'string') {
    const model = modelLabel(result.model)
    return {
      taskId: result.taskId,
      ...(model === undefined ? {} : { model }),
    }
  }
  if (!Array.isArray(result?.results)) return {}
  const entries = result.results.map(recordOf).filter(entry => entry !== undefined)
  const taskIds = entries.flatMap(entry => typeof entry.taskId === 'string' ? [entry.taskId] : [])
  const models = [...new Set(entries.flatMap(entry => {
    const label = modelLabel(entry.model)
    return label === undefined ? [] : [label]
  }))]
  return {
    ...(taskIds.length === 0 ? {} : { taskId: taskIds.join(', ') }),
    ...(models.length === 0 ? {} : { model: models.join(', ') }),
  }
}

function modelLabel(value: unknown): string | undefined {
  return isRecord(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    ? `${value.provider} / ${value.model}`
    : undefined
}

function imageDimensions(images: readonly { readonly type: 'image'; readonly attachment: ImageAttachmentRef }[]): string | undefined {
  if (images.length === 0) return undefined
  const dimensions = images.map(image => `${String(image.attachment.width)} × ${String(image.attachment.height)}`)
  const unique = [...new Set(dimensions)]
  return unique.length === 1 && images.length > 1 ? `${unique[0]} · ${String(images.length)}` : unique.join(', ')
}

function batchFailures(result: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(result?.failures)) return []
  return result.failures.flatMap((value, index) => {
    const failure = recordOf(value)
    if (failure === undefined || typeof failure.error !== 'string') return []
    const prompt = typeof failure.prompt === 'string' ? firstLine(failure.prompt) : `#${String(index + 1)}`
    return [`${prompt}: ${failure.error}`]
  })
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u, 1)[0]?.slice(0, 120) ?? ''
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pretty(value: string): string {
  const parsed = parseJson(value)
  return parsed === undefined ? value : JSON.stringify(parsed, null, 2)
}

function ImageGlyph(): ReactNode {
  return <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="2.5" y="3" width="13" height="12" rx="2" /><circle cx="6.3" cy="6.7" r="1.2" /><path d="m4.5 12 3-3 2.2 2 1.4-1.3 2.5 2.3" /></svg>
}
