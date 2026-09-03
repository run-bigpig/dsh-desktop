import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconCloseOutline16,
  IconFolderClose16,
  IconPanelLeftOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  GitSnapshot, StoredImageView,
  WorkspaceDirectorySnapshot, WorkspaceFileSnapshot, WorkspaceFileWriteRequest, WorkspaceFileWriteResult,
  WorkspaceSearchSnapshot,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { GitWorkbenchActions } from './GitWorkbench.tsx'
import { ImageStudio } from '../image/ImageStudio.tsx'
import { WorkspaceWorkbench } from './WorkspaceWorkbench.tsx'
import css from './SessionWorkbench.module.css'

export const WORKSPACE_DRAG_MIME = 'application/x-dsh-workspace-file-reference+json'
export const HARNESS_FILE_REFERENCE_SOURCE = 'reference'

export interface WorkspaceDragPayload {
  readonly sessionId: string
  readonly path: string
  readonly name: string
}

type Listener = () => void

export interface ImageStudioIntent {
  readonly sessionId: string
  readonly sourceImage: StoredImageView
  readonly label: string
  readonly loadImage: () => Promise<string>
}

export class WorkbenchController {
  private open = false
  private drag: WorkspaceDragPayload | null = null
  private imageIntent: ImageStudioIntent | null = null
  private readonly openListeners = new Set<Listener>()
  private readonly dragListeners = new Set<Listener>()
  private readonly imageListeners = new Set<Listener>()

  readonly subscribeOpen = (listener: Listener): (() => void) => {
    this.openListeners.add(listener)
    return () => { this.openListeners.delete(listener) }
  }

  readonly getOpen = (): boolean => this.open

  readonly subscribeDrag = (listener: Listener): (() => void) => {
    this.dragListeners.add(listener)
    return () => { this.dragListeners.delete(listener) }
  }

  readonly getDrag = (): WorkspaceDragPayload | null => this.drag

  readonly subscribeImage = (listener: Listener): (() => void) => {
    this.imageListeners.add(listener)
    return () => { this.imageListeners.delete(listener) }
  }

  readonly getImage = (): ImageStudioIntent | null => this.imageIntent

  toggle(): void {
    if (this.open) this.close()
    else this.setOpen(true)
  }

  close(): void {
    if (this.imageIntent !== null) {
      this.imageIntent = null
      for (const listener of this.imageListeners) listener()
    }
    this.setOpen(false)
  }

  openImage(intent: ImageStudioIntent): void {
    this.imageIntent = intent
    for (const listener of this.imageListeners) listener()
    this.setOpen(true)
  }

  startDrag(payload: WorkspaceDragPayload): void {
    this.drag = payload
    for (const listener of this.dragListeners) listener()
  }

  endDrag(): void {
    if (this.drag === null) return
    this.drag = null
    for (const listener of this.dragListeners) listener()
  }

  private setOpen(next: boolean): void {
    if (this.open === next) return
    this.open = next
    for (const listener of this.openListeners) listener()
  }
}

export interface WorkbenchLauncherInjected {
  readonly controller: WorkbenchController
}

export type WorkbenchLauncherProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'desktop.workbench'>
  & InjectFace<WorkbenchLauncherInjected>

export function WorkbenchLauncher({ controller, t }: WorkbenchLauncherProps): ReactNode {
  const open = useSyncExternalStore(controller.subscribeOpen, controller.getOpen)
  return (
    <Tooltip label={open ? t('close') : t('open')} side="bottom" delayMs={500}>
      <button
        className={css.headerLauncher}
        data-active={open || undefined}
        type="button"
        aria-label={open ? t('close') : t('open')}
        aria-pressed={open}
        onClick={() => { controller.toggle() }}
      >
        <IconPanelLeftOutline16 className={css.headerLauncherIcon} size={16} />
      </button>
    </Tooltip>
  )
}

export interface WorkbenchDrawerInjected {
  readonly controller: WorkbenchController
  readonly openDetails: () => void
  readonly listDirectory: (
    sessionId: string,
    directory: string,
    signal: AbortSignal,
  ) => Promise<WorkspaceDirectorySnapshot>
  readonly searchWorkspace: (sessionId: string, query: string, signal: AbortSignal) => Promise<WorkspaceSearchSnapshot>
  readonly readWorkspaceFile: (sessionId: string, path: string, signal: AbortSignal) => Promise<WorkspaceFileSnapshot>
  readonly writeWorkspaceFile: (
    sessionId: string,
    request: WorkspaceFileWriteRequest,
    signal: AbortSignal,
  ) => Promise<WorkspaceFileWriteResult>
  readonly gitActions: (sessionId: string) => GitWorkbenchActions
  readonly submitImageEdit: (sessionId: string, instruction: string, file: File) => boolean
}

export type WorkbenchDrawerProps =
  PropsRuntime<'details'>
  & PropsLocale<'desktop.workbench'>
  & InjectFace<WorkbenchDrawerInjected>

type WorkbenchTab = 'files' | 'git' | 'image'

type GitLoadState =
  | { readonly phase: 'idle' | 'loading' }
  | { readonly phase: 'ready'; readonly snapshot: GitSnapshot }
  | { readonly phase: 'error'; readonly message: string }

export function WorkbenchDrawer({
  useSessions, controller, listDirectory, searchWorkspace, readWorkspaceFile, writeWorkspaceFile,
  gitActions, submitImageEdit, openDetails, t,
}: WorkbenchDrawerProps): ReactNode {
  const open = useSyncExternalStore(controller.subscribeOpen, controller.getOpen)
  const imageIntent = useSyncExternalStore(controller.subscribeImage, controller.getImage)
  const current = useSessions(state => state.current)
  const summary = useSessions(state => current === undefined ? undefined : state.byId[current])
  const sessionId = current === undefined ? undefined : String(current)
  const [tab, setTab] = useState<WorkbenchTab>('files')
  const [git, setGit] = useState<GitLoadState>({ phase: 'idle' })
  const currentGitActions = useMemo(
    () => sessionId === undefined ? undefined : gitActions(sessionId),
    [gitActions, sessionId],
  )

  useEffect(() => {
    setTab(imageIntent?.sessionId === sessionId ? 'image' : 'files')
  }, [imageIntent, sessionId])

  useEffect(() => {
    if (open) openDetails()
  }, [open, openDetails, sessionId])

  useEffect(() => {
    if (!open || currentGitActions === undefined) {
      setGit({ phase: 'idle' })
      return
    }
    const abort = new AbortController()
    setGit({ phase: 'loading' })
    void currentGitActions.snapshot(abort.signal).then(
      snapshot => { if (!abort.signal.aborted) setGit({ phase: 'ready', snapshot }) },
      error => {
        if (!abort.signal.aborted) setGit({
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
    return () => { abort.abort() }
  }, [currentGitActions, open])

  const gitVisible = git.phase === 'ready' && git.snapshot.available
  useEffect(() => {
    if (!gitVisible && tab === 'git') setTab('files')
  }, [gitVisible, tab])

  if (!open) return null

  return (
    <aside className={css.drawer} aria-label={t('title')}>
      <header className={css.header}>
        <div className={css.headingGroup}>
          <h2>{t('title')}</h2>
          <p>{summary?.cwd ?? t('noSession')}</p>
        </div>
        <button className={css.iconButton} type="button" aria-label={t('close')} onClick={() => { controller.close() }}>
          <IconCloseOutline16 />
        </button>
      </header>
      <div className={css.tabBar} role="tablist" aria-label={t('title')}>
        <button
          className={css.tab}
          data-active={tab === 'files' || undefined}
          type="button"
          role="tab"
          aria-selected={tab === 'files'}
          onClick={() => { setTab('files') }}
        >
          {t('files')}
        </button>
        {gitVisible && (
          <button
            className={css.tab}
            data-active={tab === 'git' || undefined}
            type="button"
            role="tab"
            aria-selected={tab === 'git'}
            onClick={() => { setTab('git') }}
          >
            {t('git')}
          </button>
        )}
        {imageIntent?.sessionId === sessionId && (
          <button
            className={css.tab}
            data-active={tab === 'image' || undefined}
            type="button"
            role="tab"
            aria-selected={tab === 'image'}
            onClick={() => { setTab('image') }}
          >
            {t('imageStudio')}
          </button>
        )}
      </div>
      <section className={css.content} role="tabpanel">
        {sessionId === undefined
          ? <EmptyState title={t('noSession')} description={t('noSessionHint')} />
          : tab === 'files' || tab === 'git' ? (
            <WorkspaceWorkbench
              key={sessionId}
              sessionId={sessionId}
              scope={`${sessionId}:${summary?.cwd ?? ''}`}
              activePanel={tab}
              controller={controller}
              listDirectory={(directory, signal) => listDirectory(sessionId, directory, signal)}
              search={(query, signal) => searchWorkspace(sessionId, query, signal)}
              readFile={(path, signal) => readWorkspaceFile(sessionId, path, signal)}
              writeFile={(request, signal) => writeWorkspaceFile(sessionId, request, signal)}
              gitSnapshot={git.phase === 'ready' ? git.snapshot : null}
              {...(currentGitActions === undefined ? {} : { gitActions: currentGitActions })}
              onGitSnapshot={snapshot => { setGit({ phase: 'ready', snapshot }) }}
              onPreviewVisibility={ignorePreviewVisibility}
              t={t}
            />
            ) : null}
        {sessionId !== undefined && imageIntent?.sessionId === sessionId && (
          <div className={css.imagePanel} hidden={tab !== 'image'}>
            <ImageStudio
              key={`${sessionId}:${imageIntent.sourceImage.attachmentId}`}
              sessionId={sessionId}
              intent={imageIntent}
              submitImage={submitImageEdit}
              onReturn={() => { controller.close() }}
              t={t}
            />
          </div>
        )}
      </section>
    </aside>
  )
}

const ignorePreviewVisibility = (): void => undefined

function EmptyState({ title, description, action }: {
  title: string
  description: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className={css.emptyState}>
      <IconFolderClose16 size={22} />
      <strong>{title}</strong>
      <span>{description}</span>
      {action}
    </div>
  )
}

export interface WorkspaceReferenceDropDockInjected {
  readonly controller: WorkbenchController
  readonly insertFile: (path: string, span: TokenSpan) => boolean
}

export type WorkspaceReferenceDropDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'desktop.workbench'>
  & InjectFace<WorkspaceReferenceDropDockInjected>

export function WorkspaceReferenceDropDock({
  sessionId, useInput, controller, insertFile, t,
}: WorkspaceReferenceDropDockProps): ReactNode {
  const drag = useSyncExternalStore(controller.subscribeDrag, controller.getDrag)
  const input = useInput(state => state)
  if (drag === null || drag.sessionId !== String(sessionId)) return null
  const disabled = input.phase === 'adjudicating' || input.phase === 'submitting'

  return (
    <div
      className={css.dropDock}
      data-disabled={disabled || undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(WORKSPACE_DRAG_MIME)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(WORKSPACE_DRAG_MIME)) return
        event.preventDefault()
        if (!disabled) {
          insertFile(drag.path, {
            start: input.draft.length,
            end: input.draft.length,
            draftRev: input.draftRev,
          })
        }
        controller.endDrag()
      }}
    >
      <span className={css.dropIcon}><FileGlyph /></span>
      <span>
        <strong>{disabled ? t('dropUnavailable') : t('dropFile')}</strong>
        <small>{drag.path}</small>
      </span>
    </div>
  )
}

export function workspaceFileReferenceOf(path: string): ReferenceInsert | undefined {
  const mention = formatFileMention({ path, kind: 'file' }, false)
  if (mention === undefined) return undefined
  const label = path.slice(path.lastIndexOf('/') + 1)
  return {
    source: HARNESS_FILE_REFERENCE_SOURCE,
    ref: mention,
    label,
    appearance: 'file',
    clipboardText: mention,
  }
}

function FileGlyph(): ReactNode {
  return <span className={css.fileGlyph}><span /></span>
}
