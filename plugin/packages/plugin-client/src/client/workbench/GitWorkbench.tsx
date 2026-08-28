import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconBranchOutline16, IconPlusOutline16, IconRefreshOutline14, IconTrashOutline16, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitFileState, GitSnapshot } from '@run-bigpig/dsh-desktop-plugin-host/types'
import css from './GitWorkbench.module.css'

export interface GitWorkbenchActions {
  readonly snapshot: (signal: AbortSignal) => Promise<GitSnapshot>
  readonly diff: (path: string, staged: boolean, signal: AbortSignal) => Promise<string>
  readonly stage: (path: string, signal: AbortSignal) => Promise<GitSnapshot>
  readonly unstage: (path: string, signal: AbortSignal) => Promise<GitSnapshot>
  readonly stageMany: (paths: readonly string[], signal: AbortSignal) => Promise<GitSnapshot>
  readonly unstageMany: (paths: readonly string[], signal: AbortSignal) => Promise<GitSnapshot>
  readonly discard: (paths: readonly string[], signal: AbortSignal) => Promise<GitSnapshot>
  readonly commit: (message: string, signal: AbortSignal) => Promise<GitSnapshot>
}

export interface GitWorkbenchCopy {
  readonly branch: string
  readonly detached: string
  readonly noRepository: string
  readonly noRepositoryHint: string
  readonly clean: string
  readonly changes: string
  readonly staged: string
  readonly unstaged: string
  readonly untracked: string
  readonly stage: string
  readonly stageAll: string
  readonly unstage: string
  readonly unstageAll: string
  readonly discard: string
  readonly discardAll: string
  readonly discardTitle: string
  readonly discardTrackedConfirm: string
  readonly discardUntrackedConfirm: string
  readonly viewList: string
  readonly viewTree: string
  readonly cancel: string
  readonly commitMessage: string
  readonly commit: string
  readonly refresh: string
  readonly operationFailed: string
}

interface ChangeRow {
  readonly id: string
  readonly path: string
  readonly fromPath?: string
  readonly staged: boolean
  readonly state: string
  readonly raw: GitFileState
}

export function GitWorkbench({
  snapshot, actions, onSnapshot, onOpenDiff, copy,
}: {
  readonly snapshot: GitSnapshot
  readonly actions: GitWorkbenchActions
  readonly onSnapshot: (snapshot: GitSnapshot) => void
  readonly onOpenDiff: (path: string, staged: boolean) => void
  readonly copy: GitWorkbenchCopy
}): ReactNode {
  const groups = useMemo(() => groupChanges(snapshot.files), [snapshot.files])
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [discardRows, setDiscardRows] = useState<readonly ChangeRow[] | null>(null)
  const [viewMode, setViewMode] = useState<'list' | 'tree'>(() => {
    try { return localStorage.getItem('dsh-workbench-git-view') === 'tree' ? 'tree' : 'list' } catch { return 'list' }
  })
  const lastFocusRefresh = useRef(-Infinity)

  const mutate = (operation: (signal: AbortSignal) => Promise<GitSnapshot>): Promise<void> => {
    const controller = new AbortController()
    setBusy(true)
    setError(null)
    return operation(controller.signal).then(next => {
      onSnapshot(next)
      setSelected(new Set())
    }, reason => {
      setError(messageOf(reason, copy.operationFailed))
    }).finally(() => { setBusy(false) })
  }

  useEffect(() => {
    const ids = new Set([...groups.staged, ...groups.unstaged, ...groups.untracked].map(row => row.id))
    setSelected(current => new Set([...current].filter(id => ids.has(id))))
  }, [groups])

  useEffect(() => {
    const refreshOnFocus = (): void => {
      const now = Date.now()
      if (now - lastFocusRefresh.current < 5_000) return
      lastFocusRefresh.current = now
      void mutate(actions.snapshot)
    }
    window.addEventListener('focus', refreshOnFocus)
    return () => { window.removeEventListener('focus', refreshOnFocus) }
  })

  if (!snapshot.repository) {
    return (
      <div className={css.empty}>
        <span className={css.gitMark}>git</span>
        <strong>{copy.noRepository}</strong>
        <p>{copy.noRepositoryHint}</p>
      </div>
    )
  }

  const selectedRows = [...groups.staged, ...groups.unstaged, ...groups.untracked].filter(row => selected.has(row.id))
  const stagedCount = groups.staged.length

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <div className={css.branch}>
          <IconBranchOutline16 size={14} />
          <span>{copy.branch}</span>
          <strong>{snapshot.branch ?? copy.detached}</strong>
        </div>
        <Tooltip label={copy.refresh} side="bottom" delayMs={400}>
          <button className={css.iconButton} type="button" aria-label={copy.refresh} onClick={() => { void mutate(actions.snapshot) }} disabled={busy}>
            <IconRefreshOutline14 />
          </button>
        </Tooltip>
      </div>
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      <div className={css.bulkBar}>
        <span>{copy.changes} · {String(groups.staged.length + groups.unstaged.length + groups.untracked.length)}</span>
        <div>
          <button
            type="button"
            disabled={busy || selectedRows.every(row => row.staged) || selectedRows.length === 0}
            title={copy.stage}
            onClick={() => { void mutate(signal => actions.stageMany(uniquePaths(selectedRows.filter(row => !row.staged)), signal)) }}
          ><IconPlusOutline16 size={13} /></button>
          <button
            type="button"
            disabled={busy || selectedRows.every(row => !row.staged) || selectedRows.length === 0}
            title={copy.unstage}
            onClick={() => { void mutate(signal => actions.unstageMany(uniquePaths(selectedRows.filter(row => row.staged)), signal)) }}
          ><span className={css.minus}>−</span></button>
          <button
            type="button"
            disabled={busy || selectedRows.length === 0 || selectedRows.some(conflicted)}
            title={copy.discard}
            onClick={() => { setDiscardRows(selectedRows) }}
          ><IconTrashOutline16 size={13} /></button>
          <button type="button" data-active={viewMode === 'list' || undefined} title={copy.viewList} onClick={() => { setViewMode('list'); storeViewMode('list') }}>≡</button>
          <button type="button" data-active={viewMode === 'tree' || undefined} title={copy.viewTree} onClick={() => { setViewMode('tree'); storeViewMode('tree') }}>⌘</button>
        </div>
      </div>
      <div className={css.statusList}>
        {groups.staged.length + groups.unstaged.length + groups.untracked.length === 0
          ? <div className={css.clean}>{copy.clean}</div>
          : (
            <>
              <ChangeGroup
                title={copy.staged}
                rows={groups.staged}
                selected={selected}
                busy={busy}
                bulkLabel={copy.unstageAll}
                onToggle={id => { setSelected(toggleSet(selected, id)) }}
                onToggleAll={() => { setSelected(toggleRows(selected, groups.staged)) }}
                onOpen={row => { onOpenDiff(row.path, true) }}
                onBulk={() => { void mutate(signal => actions.unstageMany(uniquePaths(groups.staged), signal)) }}
                onPrimary={row => { void mutate(signal => actions.unstage(row.path, signal)) }}
                onDiscard={row => { setDiscardRows([row]) }}
                primaryLabel={copy.unstage}
                discardLabel={copy.discard}
                viewMode={viewMode}
              />
              <ChangeGroup
                title={copy.unstaged}
                rows={groups.unstaged}
                selected={selected}
                busy={busy}
                bulkLabel={copy.stageAll}
                onToggle={id => { setSelected(toggleSet(selected, id)) }}
                onToggleAll={() => { setSelected(toggleRows(selected, groups.unstaged)) }}
                onOpen={row => { onOpenDiff(row.path, false) }}
                onBulk={() => { void mutate(signal => actions.stageMany(uniquePaths(groups.unstaged), signal)) }}
                onPrimary={row => { void mutate(signal => actions.stage(row.path, signal)) }}
                onDiscard={row => { setDiscardRows([row]) }}
                primaryLabel={copy.stage}
                discardLabel={copy.discard}
                viewMode={viewMode}
              />
              <ChangeGroup
                title={copy.untracked}
                rows={groups.untracked}
                selected={selected}
                busy={busy}
                bulkLabel={copy.stageAll}
                onToggle={id => { setSelected(toggleSet(selected, id)) }}
                onToggleAll={() => { setSelected(toggleRows(selected, groups.untracked)) }}
                onOpen={row => { onOpenDiff(row.path, false) }}
                onBulk={() => { void mutate(signal => actions.stageMany(uniquePaths(groups.untracked), signal)) }}
                onPrimary={row => { void mutate(signal => actions.stage(row.path, signal)) }}
                onDiscard={row => { setDiscardRows([row]) }}
                primaryLabel={copy.stage}
                discardLabel={copy.discard}
                viewMode={viewMode}
              />
            </>
            )}
      </div>
      <form className={css.commitBar} onSubmit={(event) => {
        event.preventDefault()
        if (commitMessage.trim() === '' || stagedCount === 0 || busy) return
        void mutate(signal => actions.commit(commitMessage, signal)).then(() => { setCommitMessage('') })
      }}>
        <input value={commitMessage} onChange={event => { setCommitMessage(event.currentTarget.value) }} placeholder={copy.commitMessage} aria-label={copy.commitMessage} />
        <Button variant="primary" size="sm" type="submit" disabled={commitMessage.trim() === '' || stagedCount === 0 || busy}>
          {copy.commit} · {String(stagedCount)}
        </Button>
      </form>
      <Modal
        open={discardRows !== null}
        title={copy.discardTitle}
        closeLabel={copy.cancel}
        description={discardRows?.every(row => row.state === 'untracked') ? copy.discardUntrackedConfirm : copy.discardTrackedConfirm}
        onClose={() => { setDiscardRows(null) }}
        footer={<>
          <Button variant="ghost" onClick={() => { setDiscardRows(null) }}>{copy.cancel}</Button>
          <Button variant="primary" onClick={() => {
            const rows = discardRows
            setDiscardRows(null)
            if (rows !== null) void mutate(signal => actions.discard(uniquePaths(rows), signal))
          }}>{copy.discard}</Button>
        </>}
      />
    </div>
  )
}

function ChangeGroup({
  title, rows, selected, busy, bulkLabel, primaryLabel, discardLabel, viewMode,
  onToggle, onToggleAll, onOpen, onBulk, onPrimary, onDiscard,
}: {
  readonly title: string
  readonly rows: readonly ChangeRow[]
  readonly selected: ReadonlySet<string>
  readonly busy: boolean
  readonly bulkLabel: string
  readonly primaryLabel: string
  readonly discardLabel: string
  readonly viewMode: 'list' | 'tree'
  readonly onToggle: (id: string) => void
  readonly onToggleAll: () => void
  readonly onOpen: (row: ChangeRow) => void
  readonly onBulk: () => void
  readonly onPrimary: (row: ChangeRow) => void
  readonly onDiscard: (row: ChangeRow) => void
}): ReactNode {
  if (rows.length === 0) return null
  const allSelected = rows.every(row => selected.has(row.id))
  return (
    <section className={css.group}>
      <header className={css.groupHeader}>
        <label><input type="checkbox" checked={allSelected} onChange={onToggleAll} /> <span>{title}</span><small>{rows.length}</small></label>
        <button type="button" disabled={busy || rows.every(conflicted)} onClick={onBulk}>{bulkLabel}</button>
      </header>
      {viewMode === 'tree' ? (
        <TreeRows rows={rows} render={row => <ChangeItem key={row.id} row={row} selected={selected} busy={busy} primaryLabel={primaryLabel} discardLabel={discardLabel} onToggle={onToggle} onOpen={onOpen} onPrimary={onPrimary} onDiscard={onDiscard} />} />
      ) : rows.map(row => <ChangeItem key={row.id} row={row} selected={selected} busy={busy} primaryLabel={primaryLabel} discardLabel={discardLabel} onToggle={onToggle} onOpen={onOpen} onPrimary={onPrimary} onDiscard={onDiscard} />)}
    </section>
  )
}

function ChangeItem({ row, selected, busy, primaryLabel, discardLabel, onToggle, onOpen, onPrimary, onDiscard }: {
  readonly row: ChangeRow
  readonly selected: ReadonlySet<string>
  readonly busy: boolean
  readonly primaryLabel: string
  readonly discardLabel: string
  readonly onToggle: (id: string) => void
  readonly onOpen: (row: ChangeRow) => void
  readonly onPrimary: (row: ChangeRow) => void
  readonly onDiscard: (row: ChangeRow) => void
}): ReactNode {
  return <div className={css.fileRow} data-selected={selected.has(row.id) || undefined}>
    <input type="checkbox" checked={selected.has(row.id)} onChange={() => { onToggle(row.id) }} aria-label={row.path} />
    <button className={css.fileSelect} type="button" onClick={() => { onOpen(row) }}>
      <span className={css.statusCode} data-state={row.state}>{statusCode(row)}</span>
      <span className={css.fileNames}><strong>{displayName(row)}</strong><small>{directoryOf(row.path)}</small></span>
    </button>
    {!conflicted(row) && <div className={css.fileActions}>
      <button type="button" disabled={busy} title={primaryLabel} onClick={() => { onPrimary(row) }}>{row.staged ? '−' : '+'}</button>
      <button type="button" disabled={busy} title={discardLabel} onClick={() => { onDiscard(row) }}><IconTrashOutline16 size={12} /></button>
    </div>}
  </div>
}

function TreeRows({ rows, render }: { readonly rows: readonly ChangeRow[]; readonly render: (row: ChangeRow) => ReactNode }): ReactNode {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(() => {
    const result = new Map<string, ChangeRow[]>()
    for (const row of rows) {
      const directory = directoryOf(row.path) || '/'
      result.set(directory, [...(result.get(directory) ?? []), row])
    }
    return [...result.entries()]
  }, [rows])
  return <>{groups.map(([directory, entries]) => {
    const hidden = collapsed.has(directory)
    return <div className={css.directoryGroup} key={directory}>
      <button className={css.directoryRow} type="button" aria-expanded={!hidden} onClick={() => { setCollapsed(current => toggleSet(current, directory)) }}>
        {hidden ? '›' : '⌄'} <span>{directory}</span><small>{entries.length}</small>
      </button>
      {!hidden && entries.map(render)}
    </div>
  })}</>
}

function groupChanges(files: readonly GitFileState[]): { staged: ChangeRow[]; unstaged: ChangeRow[]; untracked: ChangeRow[] } {
  const staged: ChangeRow[] = []
  const unstaged: ChangeRow[] = []
  const untracked: ChangeRow[] = []
  for (const file of files) {
    if (file.index === '?' && file.worktree === '?') {
      untracked.push(change(file, false, 'untracked'))
      continue
    }
    if (hasIndexChange(file)) staged.push(change(file, true, stateOf(file.index)))
    if (hasWorktreeChange(file)) unstaged.push(change(file, false, stateOf(file.worktree)))
  }
  return { staged, unstaged, untracked }
}

function change(file: GitFileState, staged: boolean, state: string): ChangeRow {
  return {
    id: `${staged ? 's' : 'u'}:${file.path}`,
    path: file.path,
    ...(file.fromPath === undefined ? {} : { fromPath: file.fromPath }),
    staged,
    state,
    raw: file,
  }
}

function stateOf(code: string): string {
  return code === 'A' ? 'created' : code === 'M' ? 'modified' : code === 'D' ? 'deleted'
    : code === 'R' || code === 'C' ? 'renamed' : code === 'U' ? 'conflicted' : 'unknown'
}

function hasIndexChange(file: GitFileState): boolean { return file.index !== ' ' && file.index !== '?' }
function hasWorktreeChange(file: GitFileState): boolean { return file.worktree !== ' ' && file.worktree !== '?' }
function conflicted(row: ChangeRow): boolean { return row.state === 'conflicted' || row.raw.index === 'U' || row.raw.worktree === 'U' }
function statusCode(row: ChangeRow): string { return row.state === 'untracked' ? '?' : row.state === 'conflicted' ? '!' : row.staged ? row.raw.index : row.raw.worktree }
function displayName(row: ChangeRow): string { return row.fromPath === undefined ? basenameOf(row.path) : `${basenameOf(row.fromPath)} → ${basenameOf(row.path)}` }
function basenameOf(path: string): string { return path.slice(path.lastIndexOf('/') + 1) }
function directoryOf(path: string): string { const index = path.lastIndexOf('/'); return index < 0 ? '' : path.slice(0, index) }
function uniquePaths(rows: readonly ChangeRow[]): string[] { return [...new Set(rows.filter(row => !conflicted(row)).map(row => row.path))] }
function toggleSet(current: ReadonlySet<string>, id: string): Set<string> { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }
function toggleRows(current: ReadonlySet<string>, rows: readonly ChangeRow[]): Set<string> { const next = new Set(current); const remove = rows.every(row => next.has(row.id)); for (const row of rows) remove ? next.delete(row.id) : next.add(row.id); return next }
function storeViewMode(mode: 'list' | 'tree'): void { try { localStorage.setItem('dsh-workbench-git-view', mode) } catch { /* best effort */ } }
function messageOf(reason: unknown, fallback: string): string { return reason instanceof Error && reason.message !== '' ? reason.message : fallback }
