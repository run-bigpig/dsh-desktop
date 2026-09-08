import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconCloseOutline16,
  IconPanelLeftOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  GitSnapshot,
  WorkspaceDirectorySnapshot, WorkspaceFileSnapshot, WorkspaceFileWriteRequest, WorkspaceFileWriteResult,
  WorkspaceSearchSnapshot,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { GitWorkbenchActions } from './GitWorkbench.tsx'
import { BrowserWorkbench, type BrowserActions } from './BrowserWorkbench.tsx'
import { DesignSurface } from '../design/DesignConversationView.tsx'
import type { DesignConnection } from '../design/DesignConversationView.tsx'
import type { CanvasResources } from '../design/canvas-resources.ts'
import { ImageStudio } from '../image/ImageStudio.tsx'
import { WorkspaceWorkbench } from './WorkspaceWorkbench.tsx'
import css from './SessionWorkbench.module.css'

export const WORKSPACE_DRAG_MIME = 'application/x-dsh-workspace-file-reference+json'
export const HARNESS_FILE_REFERENCE_SOURCE = 'reference'

export { WorkbenchController } from './session-state.ts'
export type { ImageStudioIntent, WorkspaceDragPayload } from './session-state.ts'
import {
  WORKBENCH_WIDTH_DEFAULT,
  WORKBENCH_WIDTH_MAX,
  WORKBENCH_WIDTH_MIN,
  WorkbenchController,
} from './session-state.ts'
import { useSessionState } from './session-memory.ts'

export interface WorkbenchLauncherInjected {
  readonly controller: WorkbenchController
}

export type WorkbenchLauncherProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'desktop.workbench'>
  & InjectFace<WorkbenchLauncherInjected>

export function WorkbenchLauncher({ sessionId, controller, t }: WorkbenchLauncherProps): ReactNode {
  const { open, pending } = useSyncExternalStore(controller.subscribe, () => controller.getSession(String(sessionId)))
  const label = open ? t('close') : t('open')
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button
        className={css.headerLauncher}
        data-active={open || undefined}
        type="button"
        aria-label={label}
        aria-pressed={open}
        onClick={() => { controller.toggle(String(sessionId)) }}
      >
        <IconPanelLeftOutline16 className={css.headerLauncherIcon} size={16} />
        {pending && <span className={css.pendingDot} aria-hidden="true" />}
      </button>
    </Tooltip>
  )
}

export interface WorkbenchDrawerInjected {
  readonly controller: WorkbenchController
  readonly browserCommand: (sessionId: string, ...args: Parameters<BrowserActions>) => ReturnType<BrowserActions>
  readonly canvasResources: CanvasResources
  readonly openCanvasFile: (sessionId: string, path: string, reloadFromDisk?: boolean) => Promise<void>
  readonly connectCanvas: (sessionId: string) => Promise<DesignConnection>
  readonly openDetails: () => void
  readonly closeDetails: () => void
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

type GitLoadState =
  | { readonly phase: 'idle' | 'loading' }
  | { readonly phase: 'ready'; readonly snapshot: GitSnapshot }
  | { readonly phase: 'error'; readonly message: string }

export function WorkbenchDrawer({
  useSessions, controller, listDirectory, searchWorkspace, readWorkspaceFile, writeWorkspaceFile,
  gitActions, submitImageEdit, openDetails, closeDetails, canvasResources, connectCanvas, openCanvasFile, browserCommand, t,
}: WorkbenchDrawerProps): ReactNode {
  const current = useSessions(state => state.current)
  const summary = useSessions(state => current === undefined ? undefined : state.byId[current])
  const sessionId = current === undefined ? undefined : String(current)
  const { open, width, tab, pending } = useSyncExternalStore(controller.subscribe, () => controller.getSession(sessionId))
  const [resizing, setResizing] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  const resizeStart = useRef({ x: 0, width: 0 })
  const changeWidth = (next: number): void => {
    if (sessionId !== undefined) controller.resize(sessionId, next)
  }
  useEffect(() => {
    if (open && summary?.blank === false) openDetails()
    else closeDetails()
  }, [open, openDetails, closeDetails, sessionId, summary?.blank])

  useLayoutEffect(() => {
    if (!open || summary?.blank !== false) return
    // Extend only the active details occupant's geometry, like desktop chrome.
    // Harness still owns the frame, panel visibility and session lifecycle.
    let frame = drawerRef.current?.parentElement
    while (frame && !frame.querySelector(':scope > [data-shell-overlay]')) frame = frame.parentElement
    if (!frame) return
    const root = frame
    const syncWidth = (): void => {
      const sidebar = Number.parseFloat(root.style.gridTemplateColumns)
      if (!Number.isFinite(sidebar)) return
      const available = root.getBoundingClientRect().width - sidebar
      const target = Math.min(width, Math.max(0, available - 400))
      for (const [key, value] of [
        ['--starweave-workbench-sidebar', `${sidebar}px`],
        ['--starweave-workbench-width', `${target}px`],
      ] as const) {
        if (root.style.getPropertyValue(key) !== value) root.style.setProperty(key, value)
      }
    }
    root.classList.add(css.workbenchFrame!)
    syncWidth()
    const size = new ResizeObserver(syncWidth)
    size.observe(root)
    const geometry = new MutationObserver(syncWidth)
    geometry.observe(root, { attributes: true, attributeFilter: ['style'] })
    return () => {
      size.disconnect()
      geometry.disconnect()
      root.classList.remove(css.workbenchFrame!)
      root.style.removeProperty('--starweave-workbench-sidebar')
      root.style.removeProperty('--starweave-workbench-width')
    }
  }, [open, width, sessionId, summary?.blank])

  const visible = open && current !== undefined && summary?.blank === false

  return (
    <aside hidden={!visible} ref={drawerRef} className={css.drawer} data-workbench-resizing={resizing || undefined} aria-label={t('title')}>
      <div
        className={css.drawerResize}
        role="separator"
        aria-label={t('resizeWorkbench')}
        aria-orientation="vertical"
        aria-valuemin={WORKBENCH_WIDTH_MIN}
        aria-valuemax={WORKBENCH_WIDTH_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onDoubleClick={() => { changeWidth(WORKBENCH_WIDTH_DEFAULT) }}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
          event.preventDefault()
          changeWidth(event.key === 'Home' ? WORKBENCH_WIDTH_DEFAULT : width + (event.key === 'ArrowLeft' ? 40 : -40))
        }}
        onPointerDown={event => {
          if (event.button !== 0) return
          event.preventDefault()
          resizeStart.current = { x: event.clientX, width: (event.currentTarget.closest('[data-slot="details"]')?.parentElement ?? event.currentTarget.parentElement)!.getBoundingClientRect().width }
          event.currentTarget.setPointerCapture(event.pointerId)
          setResizing(true)
        }}
        onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            changeWidth(resizeStart.current.width + resizeStart.current.x - event.clientX)
          }
        }}
        onPointerUp={event => {
          setResizing(false)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={event => {
          setResizing(false)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      />
      <header className={css.header}>
        {tab !== 'files' && <button className={css.tab} type="button" onClick={() => { if (sessionId) controller.select(sessionId, 'files') }}>← {t('files')}</button>}
        <div className={css.headingGroup}>
          <h2>{t(tab === 'image' ? 'imageStudio' : tab)}</h2>
        </div>
        {pending && <button className={css.tab} type="button" onClick={() => { if (sessionId) controller.showPending(sessionId) }}>{t('viewAgentContent')}</button>}
        <button className={css.iconButton} type="button" aria-label={t('close')} onClick={() => { controller.close(String(sessionId)) }}>
          <IconCloseOutline16 />
        </button>
      </header>
      <section className={css.content} aria-label={t(tab === 'image' ? 'imageStudio' : tab)}
        onPointerDownCapture={() => { if (sessionId) controller.takeOver(sessionId) }}
        onKeyDownCapture={() => { if (sessionId) controller.takeOver(sessionId) }}
        onWheelCapture={() => { if (sessionId) controller.takeOver(sessionId) }}
      >
        {sessionId !== undefined && summary?.blank === false && (
          <RetainedSessionContent
            key={`${sessionId}:${summary.cwd ?? ''}`}
            sessionId={sessionId}
            cwd={summary.cwd ?? ''}
            controller={controller}
            browserCommand={browserCommand}
            canvasResources={canvasResources}
            connectCanvas={connectCanvas}
            openCanvasFile={openCanvasFile}
            visible={visible}
            listDirectory={listDirectory}
            searchWorkspace={searchWorkspace}
            readWorkspaceFile={readWorkspaceFile}
            writeWorkspaceFile={writeWorkspaceFile}
            gitActions={gitActions}
            submitImageEdit={submitImageEdit}
            t={t}
          />
        )}
      </section>
    </aside>
  )
}

function RetainedSessionContent({
  sessionId, cwd, visible, controller, listDirectory, searchWorkspace,
  readWorkspaceFile, writeWorkspaceFile, gitActions, submitImageEdit, canvasResources, connectCanvas, openCanvasFile, browserCommand, t,
}: Omit<WorkbenchDrawerInjected, 'openDetails' | 'closeDetails'> & {
  sessionId: string; cwd: string; visible: boolean; t: WorkbenchDrawerProps['t']
}): ReactNode {
  const { tab, imageIntent } = useSyncExternalStore(controller.subscribe, () => controller.getSession(sessionId))
  const memory = controller.memory(sessionId, `workspace:${cwd}`)
  const [gitRetry, setGitRetry] = useState(0)
  const [git, setGit] = useSessionState<GitLoadState>(memory, 'git.snapshot', { phase: 'idle' })
  const actions = useMemo(() => ({
    listDirectory: (directory: string, signal: AbortSignal) => listDirectory(sessionId, directory, signal),
    search: (query: string, signal: AbortSignal) => searchWorkspace(sessionId, query, signal),
    readFile: (path: string, signal: AbortSignal) => readWorkspaceFile(sessionId, path, signal),
    writeFile: (request: WorkspaceFileWriteRequest, signal: AbortSignal) => writeWorkspaceFile(sessionId, request, signal),
    git: gitActions(sessionId),
    connectCanvas: () => connectCanvas(sessionId),
    openCanvas: (path: string, reloadFromDisk?: boolean) => openCanvasFile(sessionId, path, reloadFromDisk),
    browserCommand: (...args: Parameters<BrowserActions>) => browserCommand(sessionId, ...args),
    onGitSnapshot: (snapshot: GitSnapshot) => { setGit({ phase: 'ready', snapshot }) },
  }), [sessionId, listDirectory, searchWorkspace, readWorkspaceFile, writeWorkspaceFile, gitActions, connectCanvas, openCanvasFile, browserCommand])
  useEffect(() => {
    if (!visible || (tab !== 'files' && tab !== 'git')) return
    const abort = new AbortController()
    if (git.phase !== 'ready') setGit({ phase: 'loading' })
    void actions.git.snapshot(abort.signal).then(
      snapshot => { if (!abort.signal.aborted) setGit({ phase: 'ready', snapshot }) },
      error => { if (!abort.signal.aborted) setGit({ phase: 'error', message: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { abort.abort() }
  }, [actions, visible, tab, gitRetry])
  const workspaceVisible = visible && (tab === 'files' || tab === 'git')
  return (
    <div className={css.sessionContent} hidden={!visible}>
      <div className={css.sessionContent} hidden={!workspaceVisible}>
        {tab === 'git' && git.phase === 'error' && <p role="alert">{git.message}<button type="button" onClick={() => { setGitRetry(value => value + 1) }}>{t('retry')}</button></p>}
        {tab === 'git' && (git.phase === 'idle' || git.phase === 'loading') && <p role="status">{t('loading')}</p>}
        <WorkspaceWorkbench
          sessionId={sessionId}
          scope={`${sessionId}:${cwd}`}
          activePanel={tab === 'git' ? 'git' : 'files'}
          visible={workspaceVisible}
          controller={controller}
          listDirectory={actions.listDirectory}
          search={actions.search}
          readFile={actions.readFile}
          writeFile={actions.writeFile}
          onGitSnapshot={actions.onGitSnapshot}
          gitActions={actions.git}
          gitSnapshot={git.phase === 'ready' ? git.snapshot : null}
          onOpenCanvas={actions.openCanvas}
          onPreviewVisibility={ignorePreviewVisibility}
          t={t}
        />
      </div>
      {tab === 'browser' && <BrowserWorkbench memory={memory} visible={visible} command={actions.browserCommand} t={t} />}
      {tab === 'canvas' && <DesignSurface connect={actions.connectCanvas} resources={canvasResources} visible={visible} />}
      {imageIntent !== null && (
        <div className={css.imagePanel} hidden={tab !== 'image'}>
          <ImageStudio
            key={imageIntent.sourceImage.attachmentId}
            memory={controller.memory(sessionId, `image:${imageIntent.sourceImage.attachmentId}`)}
            sessionId={sessionId}
            intent={imageIntent}
            submitImage={submitImageEdit}
            onReturn={() => { controller.close(sessionId) }}
            t={t}
          />
        </div>
      )}
    </div>
  )
}

const ignorePreviewVisibility = (): void => undefined

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
