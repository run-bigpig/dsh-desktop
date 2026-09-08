import {
  useCallback, useEffect, useMemo, useRef, type ReactNode,
} from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconFolderClose16, IconFolderOpen16,
  IconRefreshOutline14, IconSearchOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspacePanelRequest, GitSnapshot, WorkspaceDirectorySnapshot, WorkspaceEntry, WorkspaceFileSnapshot, WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult, WorkspaceSearchSnapshot,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { WorkbenchLocaleKey } from '../locales.ts'
import { GitWorkbench, type GitWorkbenchActions, type GitWorkbenchCopy } from './GitWorkbench.tsx'
import type { WorkbenchController, WorkspaceDragPayload } from './SessionWorkbench.tsx'
import {
  diffTab, loadingFileTab, tabFromFile, WorkspacePreview, type PreviewTab, type WorkspacePreviewCopy,
} from './WorkspacePreview.tsx'
import css from './WorkspaceWorkbench.module.css'
import { WORKSPACE_DRAG_MIME } from './SessionWorkbench.tsx'

import { useSessionScroll, useSessionState, type SessionMemory } from './session-memory.ts'

type Translate = (key: WorkbenchLocaleKey) => string

export interface WorkspaceWorkbenchProps {
  readonly sessionId: string
  readonly scope: string
  readonly activePanel: 'files' | 'git'
  readonly visible?: boolean
  readonly controller: WorkbenchController
  readonly listDirectory: (directory: string, signal: AbortSignal) => Promise<WorkspaceDirectorySnapshot>
  readonly search: (query: string, signal: AbortSignal) => Promise<WorkspaceSearchSnapshot>
  readonly readFile: (path: string, signal: AbortSignal) => Promise<WorkspaceFileSnapshot>
  readonly writeFile: (request: WorkspaceFileWriteRequest, signal: AbortSignal) => Promise<WorkspaceFileWriteResult>
  readonly gitSnapshot: GitSnapshot | null
  readonly gitActions?: GitWorkbenchActions
  readonly onGitSnapshot: (snapshot: GitSnapshot) => void
  readonly onOpenCanvas?: (path: string, reloadFromDisk?: boolean) => Promise<void>
  readonly onPreviewVisibility: (visible: boolean) => void
  readonly t: Translate
}

export function WorkspaceWorkbench({
  sessionId, scope, activePanel, visible = true, controller, listDirectory, search, readFile, writeFile,
  gitSnapshot, gitActions, onGitSnapshot, onPreviewVisibility, onOpenCanvas, t,
}: WorkspaceWorkbenchProps): ReactNode {
  const memory = controller.memory(sessionId, `workspace:${scope}`)
  const stored = useMemo(() => readScope(scope), [scope])
  const explorerWidth = stored.explorerWidth
  const [previewShown, setPreviewShown] = useSessionState(memory, 'previewShown', false)
  const [canvasError, setCanvasError] = useSessionState<{ path: string; message: string } | null>(memory, 'canvasError', null)
  const explorerCollapsed = stored.explorerCollapsed
  const [tabs, setTabs] = useSessionState<readonly PreviewTab[]>(memory, 'tabs', [])
  const tabsRef = useRef<readonly PreviewTab[]>([])
  tabsRef.current = tabs
  const [activeId, setActiveId] = useSessionState<string | null>(memory, 'active', null)
  const [requestedFile, setRequestedFile] = useSessionState<WorkspacePanelRequest | null>(memory, 'requestedFile', null)
  const hydrated = useRef(false)
  const requests = useRef(new Map<string, AbortController>())
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

  const replaceTab = useCallback((id: string, update: (tab: PreviewTab) => PreviewTab): void => {
    setTabs(current => current.map(tab => tab.id === id ? update(tab) : tab))
  }, [])

  const openFile = useCallback((path: string, force = false, draft?: PersistedFileTab['draft']): void => {
    if (/\.fig$/iu.test(path) && onOpenCanvas) {
      void onOpenCanvas(path).catch(error => { setCanvasError({ path, message: messageOf(error) }) })
      return
    }
    setPreviewShown(true)
    const id = `file:${path}`
    setActiveId(id)
    if (!force && tabsRef.current.some(tab => tab.id === id)) return
    setTabs(current => current.some(tab => tab.id === id) ? current : [...current, loadingFileTab(path)])
    requests.current.get(id)?.abort()
    const abort = new AbortController()
    requests.current.set(id, abort)
    void readFile(path, abort.signal).then(snapshot => {
      if (abort.signal.aborted) return
      const file = tabFromFile(snapshot)
      const restored = draft === undefined ? file : { ...file, content: draft.content, mtime: draft.baseMtime, dirty: true, changedOnDisk: snapshot.mtime !== draft.baseMtime }
      setTabs(current => current.map(tab => tab.id === id ? restored : tab))
    }, reason => {
      if (abort.signal.aborted) return
      setTabs(current => current.map(tab => tab.id === id ? { ...tab, loading: false, error: messageOf(reason) } : tab))
    })
  }, [readFile, stored.tabs, onOpenCanvas])

  const openDiff = useCallback((path: string, staged: boolean): void => {
    if (gitActions === undefined) return
    setPreviewShown(true)
    const id = `diff:${staged ? 'staged' : 'worktree'}:${path}`
    setActiveId(id)
    setTabs(current => current.some(tab => tab.id === id) ? current.map(tab => tab.id === id ? { ...tab, loading: true, error: null } : tab) : [...current, diffTab(path, staged, null, true)])
    requests.current.get(id)?.abort()
    const abort = new AbortController()
    requests.current.set(id, abort)
    void gitActions.diff(path, staged, abort.signal).then(content => {
      if (abort.signal.aborted) return
      setTabs(current => current.map(tab => tab.id === id ? diffTab(path, staged, content) : tab))
    }, reason => {
      if (abort.signal.aborted) return
      setTabs(current => current.map(tab => tab.id === id ? diffTab(path, staged, null, false, messageOf(reason)) : tab))
    })
  }, [gitActions])

  useEffect(() => () => {
    for (const abort of requests.current.values()) abort.abort()
    requests.current.clear()
  }, [])

  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    if (tabsRef.current.length > 0) {
      for (const tab of tabsRef.current) if (tab.loading) openFile(tab.path, true)
      return
    }
    const show = memory.get('previewShown', false)
    for (const item of stored.tabs) openFile(item.value, false, item.draft)
    setPreviewShown(show)
    const persistedIds = stored.tabs.map(item => `file:${item.value}`)
    if (stored.activeId !== null && persistedIds.includes(stored.activeId)) setActiveId(stored.activeId)
  }, [openFile, stored.tabs])

  useEffect(() => {
    if (!visible || !requestedFile?.path) return
    openFile(requestedFile.path)
    setRequestedFile(null)
  }, [visible, requestedFile, openFile, setRequestedFile])

  useEffect(() => { onPreviewVisibility(tabs.length > 0) }, [onPreviewVisibility, tabs.length])

  useEffect(() => {
    const persist = (): void => {
      writeScope(scope, {
        explorerWidth,
        explorerCollapsed,
        tabs: tabs.filter(tab => tab.id.startsWith('file:')).map(tab => ({ kind: 'file', value: tab.path, ...(tab.dirty && tab.content !== null ? { draft: { content: tab.content, baseMtime: tab.mtime } } : {}) })),
        activeId,
      })
    }
    const timer = window.setTimeout(persist, 150)
    return () => { window.clearTimeout(timer); persist() }
  }, [activeId, explorerCollapsed, explorerWidth, scope, tabs])

  useEffect(() => {
    if (!visible) return
    const abort = new AbortController()
    const timer = window.setInterval(() => {
      const id = activeRef.current
      if (id === null || !id.startsWith('file:')) return
      const path = id.slice(5)
      const baseMtime = tabsRef.current.find(tab => tab.id === id)?.mtime
      void readFile(path, abort.signal).then(snapshot => {
        if (abort.signal.aborted) return
        replaceTab(id, tab => {
          if (tab.mtime !== baseMtime || snapshot.mtime === tab.mtime) return tab
          return tab.dirty ? { ...tab, changedOnDisk: true } : tabFromFile(snapshot)
        })
      }, () => {})
    }, 3_000)
    return () => { window.clearInterval(timer); abort.abort() }
  }, [readFile, replaceTab, visible])

  useEffect(() => {
    if (!visible || activePanel !== 'git' || gitActions === undefined) return
    const abort = new AbortController()
    const timer = window.setInterval(() => {
      void gitActions.snapshot(abort.signal).then(snapshot => { if (!abort.signal.aborted) onGitSnapshot(snapshot) }, () => {})
    }, 30_000)
    return () => { window.clearInterval(timer); abort.abort() }
  }, [activePanel, gitActions, onGitSnapshot, visible])

  const closeTabs = (ids: readonly string[]): void => {
    for (const id of ids) { requests.current.get(id)?.abort(); requests.current.delete(id) }
    setTabs(current => {
      const removing = new Set(ids)
      const remaining = current.filter(tab => !removing.has(tab.id))
      if (activeRef.current !== null && removing.has(activeRef.current)) {
        const oldIndex = current.findIndex(tab => tab.id === activeRef.current)
        setActiveId(remaining[Math.min(oldIndex, Math.max(0, remaining.length - 1))]?.id ?? null)
      }
      return remaining
    })
  }

  const refreshTab = (id: string): void => {
    const tab = tabs.find(candidate => candidate.id === id)
    if (tab === undefined) return
    if (tab.kind === 'diff' && tab.staged !== undefined) { openDiff(tab.path, tab.staged); return }
    if (id.startsWith('file:')) openFile(tab.path, true)
  }

  const saveTab = async (id: string): Promise<WorkspaceFileWriteResult | void> => {
    const tab = tabs.find(candidate => candidate.id === id)
    if (tab === undefined || tab.content === null || !id.startsWith('file:')) return
    const result = await writeFile({ path: tab.path, content: tab.content, baseMtime: tab.mtime }, new AbortController().signal)
    replaceTab(id, current => ({ ...current, mtime: result.mtime, dirty: current.content !== tab.content, changedOnDisk: false }))
    return result
  }

  const previewCopy = previewCopyOf(t)
  const hasPreview = previewShown && tabs.length > 0
  return (
    <div className={css.workbench}>
      {canvasError && <div role="alert">{canvasError.message}<button type="button" onClick={() => {
        if (!window.confirm('保留当前恢复快照并重新读取磁盘上的设计文件？')) return
        void onOpenCanvas?.(canvasError.path, true).then(() => { setCanvasError(null) }, error => { setCanvasError({ path: canvasError.path, message: messageOf(error) }) })
      }}>重新读取磁盘文件</button><button type="button" onClick={() => { setCanvasError(null) }}>×</button></div>}
      <section className={css.sidePanel} hidden={hasPreview}>
        {activePanel === 'files' && <div className={css.gitOverview}>
          <button type="button" onClick={() => { controller.select(sessionId, 'git') }}>Git · {gitSnapshot ? gitSnapshot.repository ? `${gitSnapshot.branch ?? t('detached')} · ${gitSnapshot.files.length} ${t('changes')}` : t('noRepository') : t('refreshGit')}</button>
          {gitSnapshot?.files.slice(0, 5).map(file => <button type="button" key={file.path} onClick={() => { openDiff(file.path, file.worktree === ' ') }}>{file.path}</button>)}
        </div>}
        <div className={css.retainedPanel} hidden={activePanel !== 'files'}>
          <WorkspaceExplorer
            memory={memory}
            sessionId={sessionId}
            visible={visible && activePanel === 'files'}
            controller={controller}
            listDirectory={listDirectory}
            search={search}
            onOpenFile={openFile}
            t={t}
          />
        </div>
        {gitSnapshot !== null && gitActions !== undefined ? (
          <div className={css.retainedPanel} hidden={activePanel !== 'git'}>
          <GitWorkbench
            memory={memory}
            visible={visible && activePanel === 'git'}
            snapshot={gitSnapshot}
            actions={gitActions}
            onSnapshot={onGitSnapshot}
            onOpenDiff={openDiff}
            copy={gitCopyOf(t)}
          />
          </div>
        ) : null}
      </section>
      {hasPreview && <>
        <div className={css.previewHeader}><button type="button" onClick={() => { setPreviewShown(false) }}>← {t(activePanel)}</button></div>
        <WorkspacePreview
          memory={memory}
          visible={visible}
          tabs={tabs}
          activeId={activeId}
          copy={previewCopy}
          onActivate={setActiveId}
          onClose={closeTabs}
          onChange={(id, content) => { replaceTab(id, tab => ({ ...tab, content, dirty: true })) }}
          onRefresh={refreshTab}
          onSave={saveTab}
        />
      </>}
    </div>
  )
}

function WorkspaceExplorer({ memory, sessionId, visible, controller, listDirectory, search, onOpenFile, t }: {
  readonly memory: SessionMemory
  readonly sessionId: string
  readonly controller: WorkbenchController
  readonly visible: boolean
  readonly listDirectory: WorkspaceWorkbenchProps['listDirectory']
  readonly search: WorkspaceWorkbenchProps['search']
  readonly onOpenFile: (path: string) => void
  readonly t: Translate
}): ReactNode {
  const scrollRef = useSessionScroll(memory, 'explorer.scroll', visible)
  const [directories, setDirectories] = useSessionState<ReadonlyMap<string, DirectoryView>>(memory, 'explorer.directories', () => new Map())
  const directoriesRef = useRef<ReadonlyMap<string, DirectoryView>>(new Map())
  const [expanded, setExpanded] = useSessionState<ReadonlySet<string>>(memory, 'explorer.expanded', () => new Set())
  const expandedRef = useRef<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useSessionState<string | null>(memory, 'explorer.selected', null)
  const [query, setQuery] = useSessionState(memory, 'explorer.query', '')
  const [searchState, setSearchState] = useSessionState<SearchView>(memory, 'explorer.searchState', { phase: 'idle' })
  directoriesRef.current = directories
  expandedRef.current = expanded
  const controllers = useRef(new Map<string, AbortController>())

  const update = useCallback((change: (current: ReadonlyMap<string, DirectoryView>) => ReadonlyMap<string, DirectoryView>): void => {
    const next = change(directoriesRef.current)
    directoriesRef.current = next
    setDirectories(next)
  }, [])

  const load = useCallback(async (directory: string, quiet = false): Promise<WorkspaceDirectorySnapshot | null> => {
    controllers.current.get(directory)?.abort()
    const abort = new AbortController()
    controllers.current.set(directory, abort)
    if (!quiet) update(current => new Map(current).set(directory, { phase: 'loading' }))
    try {
      const snapshot = await listDirectory(directory, abort.signal)
      if (!abort.signal.aborted) update(current => new Map(current).set(directory, { phase: 'ready', snapshot }))
      return snapshot
    } catch (reason) {
      if (!abort.signal.aborted && !quiet) update(current => new Map(current).set(directory, { phase: 'error', message: messageOf(reason) }))
      return null
    }
  }, [listDirectory, update])

  useEffect(() => {
    if (!visible) return
    void load('')
    const timer = window.setInterval(() => {
      for (const directory of ['', ...expandedRef.current]) void load(directory, true)
    }, 3_000)
    return () => {
      window.clearInterval(timer)
      for (const abort of controllers.current.values()) abort.abort()
      controllers.current.clear()
    }
  }, [load, visible])

  useEffect(() => {
    if (!visible) return
    const trimmed = query.trim()
    if (trimmed === '') { setSearchState({ phase: 'idle' }); return }
    const abort = new AbortController()
    const timer = window.setTimeout(() => {
      setSearchState({ phase: 'loading' })
      void search(trimmed, abort.signal).then(snapshot => {
        if (!abort.signal.aborted) setSearchState({ phase: 'ready', snapshot })
      }, reason => {
        if (!abort.signal.aborted) setSearchState({ phase: 'error', message: messageOf(reason) })
      })
    }, 150)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [query, search, visible])

  const reveal = async (path: string): Promise<void> => {
    const parts = path.split('/')
    const ancestors: string[] = []
    for (let index = 1; index < parts.length; index += 1) ancestors.push(parts.slice(0, index).join('/'))
    const next = new Set(expandedRef.current)
    for (const ancestor of ancestors) { next.add(ancestor); await load(ancestor) }
    expandedRef.current = next
    setExpanded(next)
    setSelected(path)
    onOpenFile(path)
  }

  const root = directories.get('')
  return (
    <div ref={scrollRef} className={css.explorer}>
      <div className={css.explorerToolbar}>
        <span title={root?.snapshot?.rootName}>{root?.snapshot?.rootName ?? t('workspace')}</span>
        <Tooltip label={t('refresh')} side="bottom" delayMs={400}><button type="button" aria-label={t('refresh')} onClick={() => { for (const directory of ['', ...expandedRef.current]) void load(directory) }}><IconRefreshOutline14 /></button></Tooltip>
      </div>
      <label className={css.search}><IconSearchOutline16 size={14} /><input value={query} placeholder={t('searchFiles')} onChange={event => { setQuery(event.currentTarget.value) }} /></label>
      <div data-workspace-scroll="tree" className={css.tree} role="tree" aria-label={t('files')}>
        {query.trim() !== '' ? <SearchResults state={searchState} selected={selected} onOpen={path => { void reveal(path) }} t={t} /> : (
          <>
            {root?.phase === 'loading' && <StatusRow>{t('loading')}</StatusRow>}
            {root?.phase === 'error' && <StatusRow>{root.message ?? t('loadFailed')}</StatusRow>}
            {root?.phase === 'ready' && root.snapshot !== undefined && root.snapshot.entries.map(entry => (
              <TreeRow key={entry.path} entry={entry} depth={0} selected={selected} expanded={expanded} directories={directories} sessionId={sessionId} controller={controller} load={load} onExpand={next => { expandedRef.current = next; setExpanded(next) }} onOpen={path => { setSelected(path); onOpenFile(path) }} t={t} />
            ))}
          </>
        )}
      </div>
      <div className={css.dragHint}>{t('dragHint')}</div>
    </div>
  )
}

function TreeRow({ entry, depth, selected, expanded, directories, sessionId, controller, load, onExpand, onOpen, t }: {
  readonly entry: WorkspaceEntry
  readonly depth: number
  readonly selected: string | null
  readonly expanded: ReadonlySet<string>
  readonly directories: ReadonlyMap<string, DirectoryView>
  readonly sessionId: string
  readonly controller: WorkbenchController
  readonly load: (directory: string, quiet?: boolean) => Promise<WorkspaceDirectorySnapshot | null>
  readonly onExpand: (expanded: ReadonlySet<string>) => void
  readonly onOpen: (path: string) => void
  readonly t: Translate
}): ReactNode {
  const open = expanded.has(entry.path)
  const directory = entry.kind === 'directory' ? directories.get(entry.path) : undefined
  const toggle = (): void => {
    if (entry.kind === 'file') { onOpen(entry.path); return }
    const next = new Set(expanded)
    if (open) next.delete(entry.path)
    else { next.add(entry.path); void load(entry.path) }
    onExpand(next)
  }
  const payload: WorkspaceDragPayload = { sessionId, path: entry.path, name: entry.name }
  return <>
    <div
      className={css.treeRow}
      data-selected={selected === entry.path || undefined}
      data-kind={entry.kind}
      role="treeitem"
      tabIndex={0}
      aria-expanded={entry.kind === 'directory' ? open : undefined}
      style={{ paddingLeft: 8 + depth * 15 }}
      draggable={entry.kind === 'file'}
      onClick={toggle}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() } }}
      onDragStart={entry.kind === 'file' ? event => {
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData(WORKSPACE_DRAG_MIME, JSON.stringify(payload))
        event.dataTransfer.setData('text/plain', `@${entry.path}`)
        controller.startDrag(payload)
      } : undefined}
      onDragEnd={entry.kind === 'file' ? () => { controller.endDrag() } : undefined}
      title={entry.path}
    >
      <span className={css.chevron}>{entry.kind === 'directory' ? open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 /> : null}</span>
      <span className={css.fileIcon}>{entry.kind === 'directory' ? open ? <IconFolderOpen16 /> : <IconFolderClose16 /> : <FileGlyph name={entry.name} />}</span>
      <span className={css.entryName}>{entry.name}</span>
    </div>
    {entry.kind === 'directory' && open && <div role="group">
      {directory?.phase === 'loading' && <StatusRow depth={depth + 1}>{t('loading')}</StatusRow>}
      {directory?.phase === 'error' && <button className={css.inlineError} style={{ paddingLeft: 34 + depth * 15 }} type="button" onClick={() => { void load(entry.path) }}>{t('loadFailed')} · {t('retry')}</button>}
      {directory?.phase === 'ready' && directory.snapshot !== undefined && (directory.snapshot.entries.length === 0 ? <StatusRow depth={depth + 1}>{t('emptyFolder')}</StatusRow> : directory.snapshot.entries.map(child => <TreeRow key={child.path} entry={child} depth={depth + 1} selected={selected} expanded={expanded} directories={directories} sessionId={sessionId} controller={controller} load={load} onExpand={onExpand} onOpen={onOpen} t={t} />))}
    </div>}
  </>
}

function SearchResults({ state, selected, onOpen, t }: { state: SearchView; selected: string | null; onOpen: (path: string) => void; t: Translate }): ReactNode {
  if (state.phase !== 'ready') return <StatusRow>{state.phase === 'error' ? state.message : t('searching')}</StatusRow>
  if (state.snapshot.hits.length === 0) return <StatusRow>{t('noSearchResults')}</StatusRow>
  return <>{state.snapshot.hits.map(hit => <button className={css.searchResult} data-selected={selected === hit.path || undefined} type="button" key={hit.path} onClick={() => { onOpen(hit.path) }}><FileGlyph name={hit.name} /><span><strong>{hit.name}</strong><small>{directoryOf(hit.path)}</small></span></button>)}{state.snapshot.truncated && <StatusRow>{t('searchTruncated')}</StatusRow>}</>
}

interface DirectoryView { readonly phase: 'loading' | 'ready' | 'error'; readonly snapshot?: WorkspaceDirectorySnapshot; readonly message?: string }
type SearchView = { readonly phase: 'idle' | 'loading' } | { readonly phase: 'ready'; readonly snapshot: WorkspaceSearchSnapshot } | { readonly phase: 'error'; readonly message: string }
interface PersistedFileTab { readonly kind: 'file'; readonly value: string; readonly draft?: { readonly content: string; readonly baseMtime: number } }
interface PersistedScope { readonly explorerWidth: number; readonly explorerCollapsed: boolean; readonly tabs: readonly PersistedFileTab[]; readonly activeId: string | null }
const DEFAULT_SCOPE: PersistedScope = { explorerWidth: 260, explorerCollapsed: false, tabs: [], activeId: null }
const PERSIST_KEY = 'dsh-session-workbench-scopes-v1'

function readScope(scope: string): PersistedScope {
  try {
    const parsed = JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}') as { scopes?: Record<string, { explorerWidth?: unknown; explorerCollapsed?: unknown; tabs?: unknown; activeId?: unknown }> }
    const value = JSON.parse(localStorage.getItem('starweave-workspace-v2:' + scope) ?? 'null') ?? parsed.scopes?.[scope]
    if (value === undefined) return DEFAULT_SCOPE
    return {
      explorerWidth: Math.min(500, Math.max(220, Number(value.explorerWidth) || 260)),
      explorerCollapsed: value.explorerCollapsed === true,
      tabs: Array.isArray(value.tabs) ? value.tabs.filter(isPersistedFileTab) : [],
      activeId: typeof value.activeId === 'string' && value.activeId.startsWith('file:') ? value.activeId : null,
    }
  } catch { return DEFAULT_SCOPE }
}

function isPersistedFileTab(value: unknown): value is PersistedFileTab {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<PersistedFileTab>
  return item.kind === 'file' && typeof item.value === 'string'
    && (item.draft === undefined || (item.draft !== null && typeof item.draft.content === 'string' && typeof item.draft.baseMtime === 'number' && Number.isFinite(item.draft.baseMtime)))
}

function writeScope(scope: string, value: PersistedScope): void {
  try {
    localStorage.setItem('starweave-workspace-v2:' + scope, JSON.stringify(value))
  } catch { /* best effort */ }
}

function FileGlyph({ name }: { name: string }): ReactNode { const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1, name.lastIndexOf('.') + 4).toLocaleUpperCase() : '•'; return <span className={css.fileGlyph}>{extension}</span> }
function StatusRow({ children, depth = 0 }: { children: ReactNode; depth?: number }): ReactNode { return <div className={css.statusRow} style={{ paddingLeft: 32 + depth * 15 }}>{children}</div> }
function messageOf(reason: unknown): string { return reason instanceof Error && reason.message !== '' ? reason.message : String(reason) }
function directoryOf(path: string): string { const index = path.lastIndexOf('/'); return index < 0 ? '' : path.slice(0, index) }

function gitCopyOf(t: Translate): GitWorkbenchCopy {
  return { branch: t('branch'), detached: t('detached'), noRepository: t('noRepository'), noRepositoryHint: t('noRepositoryHint'), clean: t('clean'), changes: t('changes'), staged: t('staged'), unstaged: t('unstaged'), untracked: t('untracked'), stage: t('stage'), stageAll: t('stageAll'), unstage: t('unstage'), unstageAll: t('unstageAll'), discard: t('discardChanges'), discardAll: t('discardAll'), discardTitle: t('discardTitle'), discardTrackedConfirm: t('discardTrackedConfirm'), discardUntrackedConfirm: t('discardUntrackedConfirm'), viewList: t('viewList'), viewTree: t('viewTree'), cancel: t('cancel'), commitMessage: t('commitMessage'), commit: t('commit'), refresh: t('refreshGit'), operationFailed: t('gitOperationFailed') }
}

function previewCopyOf(t: Translate): WorkspacePreviewCopy {
  return { preview: t('preview'), closePreview: t('closeImagePreview'), noPreview: t('noPreview'), noPreviewHint: t('noPreviewHint'), close: t('closeTab'), closeOthers: t('closeOthers'), closeAll: t('closeAll'), dirtyCloseTitle: t('dirtyCloseTitle'), dirtyCloseHint: t('dirtyCloseHint'), discard: t('discardChanges'), cancel: t('cancel'), refresh: t('refreshPreview'), updated: t('updatedOnDisk'), source: t('source'), rendered: t('rendered'), split: t('split'), save: t('saveFile'), download: t('download'), loading: t('previewLoading'), loadFailed: t('previewLoadFailed'), truncated: t('previewTruncated'), unsupported: t('unsupportedPreview'), unsupportedHint: t('unsupportedPreviewHint'), moreTabs: t('moreTabs'), saveFailed: t('saveFileFailed'), markdownCopy: t('markdownCopy'), markdownCopied: t('markdownCopied'), markdownFootnotes: t('markdownFootnotes') }
}
