import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconCloseOutline16, IconCodeOutline16, IconDownloadOutline16, IconEllipsisOutline16,
  IconRefreshOutline14, MarkdownText, Menu, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceFileSnapshot, WorkspaceFileWriteResult } from '@run-bigpig/dsh-desktop-plugin-host/types'
import { HarnessImage } from '../image/ImagePreview.tsx'
import css from './WorkspacePreview.module.css'

export type PreviewKind = 'markdown' | 'html' | 'code' | 'csv' | 'image' | 'pdf' | 'office' | 'text' | 'diff'

export interface PreviewTab {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly kind: PreviewKind
  readonly content: string | null
  readonly mediaType: string
  readonly size: number
  readonly mtime: number
  readonly truncated: boolean
  readonly loading: boolean
  readonly error: string | null
  readonly dirty: boolean
  readonly changedOnDisk: boolean
  readonly staged?: boolean
}

export interface WorkspacePreviewCopy {
  readonly preview: string
  readonly closePreview: string
  readonly noPreview: string
  readonly noPreviewHint: string
  readonly close: string
  readonly closeOthers: string
  readonly closeAll: string
  readonly dirtyCloseTitle: string
  readonly dirtyCloseHint: string
  readonly discard: string
  readonly cancel: string
  readonly refresh: string
  readonly updated: string
  readonly source: string
  readonly rendered: string
  readonly split: string
  readonly save: string
  readonly download: string
  readonly loading: string
  readonly loadFailed: string
  readonly truncated: string
  readonly unsupported: string
  readonly unsupportedHint: string
  readonly moreTabs: string
  readonly saveFailed: string
  readonly markdownCopy: string
  readonly markdownCopied: string
  readonly markdownFootnotes: string
}

export interface WorkspacePreviewProps {
  readonly tabs: readonly PreviewTab[]
  readonly activeId: string | null
  readonly copy: WorkspacePreviewCopy
  readonly onActivate: (id: string) => void
  readonly onClose: (ids: readonly string[]) => void
  readonly onChange: (id: string, content: string) => void
  readonly onRefresh: (id: string) => void
  readonly onSave: (id: string) => Promise<WorkspaceFileWriteResult | void>
}

export function WorkspacePreview({
  tabs, activeId, copy, onActivate, onClose, onChange, onRefresh, onSave,
}: WorkspacePreviewProps): ReactNode {
  const active = tabs.find(tab => tab.id === activeId) ?? null
  const tabElements = useRef(new Map<string, HTMLButtonElement>())
  const [sourceMode, setSourceMode] = useState(false)
  const [split, setSplit] = useState(false)
  const [closing, setClosing] = useState<readonly string[] | null>(null)
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null)
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const splitRatio = usePersistentRatio()
  const [ratio, setRatio] = splitRatio
  const tabMenuItems = useMemo(() => tabs.map(tab => ({ id: tab.id, label: tab.title })), [tabs])

  useEffect(() => {
    setSourceMode(active?.kind === 'code' || active?.kind === 'text')
    setSplit(false)
    setSaveError(null)
  }, [active?.id, active?.kind])

  useEffect(() => {
    if (activeId === null) return
    tabElements.current.get(activeId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  useEffect(() => {
    if (context === null) return
    const dismiss = (): void => { setContext(null) }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [context])

  const requestClose = (ids: readonly string[]): void => {
    const real = ids.filter(id => tabs.some(tab => tab.id === id))
    if (real.length === 0) return
    if (real.some(id => tabs.find(tab => tab.id === id)?.dirty)) setClosing(real)
    else onClose(real)
  }

  const save = (): void => {
    if (active === null || !active.dirty || saving) return
    setSaving(true)
    setSaveError(null)
    void onSave(active.id).catch(reason => {
      setSaveError(reason instanceof Error && reason.message !== '' ? reason.message : copy.saveFailed)
    }).finally(() => { setSaving(false) })
  }

  return (
    <section className={css.panel} aria-label={copy.preview}>
      <div className={css.tabsRow}>
        <div className={css.tabs} role="tablist" aria-label={copy.preview}>
          {tabs.map(tab => (
            <button
              ref={element => { if (element === null) tabElements.current.delete(tab.id); else tabElements.current.set(tab.id, element) }}
              className={css.tab}
              data-active={tab.id === activeId || undefined}
              data-dirty={tab.dirty || undefined}
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              title={tab.path}
              key={tab.id}
              onClick={() => { onActivate(tab.id) }}
              onMouseDown={event => { if (event.button === 1) { event.preventDefault(); requestClose([tab.id]) } }}
              onContextMenu={event => { event.preventDefault(); setContext({ id: tab.id, x: event.clientX, y: event.clientY }) }}
            >
              <span>{tab.title}</span>
              <i aria-hidden="true" />
              <span
                className={css.tabClose}
                role="button"
                tabIndex={-1}
                aria-label={copy.close}
                onClick={event => { event.stopPropagation(); requestClose([tab.id]) }}
              ><IconCloseOutline16 size={12} /></span>
            </button>
          ))}
        </div>
        {tabs.length > 1 && <Menu
          open={tabsMenuOpen}
          items={tabMenuItems}
          selectedId={activeId ?? undefined}
          align="end"
          portal
          compact
          className={css.moreMenu ?? ''}
          onClose={() => { setTabsMenuOpen(false) }}
          onSelect={id => { onActivate(id); setTabsMenuOpen(false) }}
          anchor={<button className={css.moreButton} type="button" title={copy.moreTabs} aria-label={copy.moreTabs} aria-haspopup="menu" aria-expanded={tabsMenuOpen} onClick={() => { setTabsMenuOpen(open => !open) }}><IconEllipsisOutline16 /></button>}
        />}
      </div>
      {active === null ? (
        <div className={css.placeholder}>
          <IconCodeOutline16 size={24} />
          <strong>{copy.noPreview}</strong>
          <span>{copy.noPreviewHint}</span>
        </div>
      ) : (
        <div className={css.activeView}>
          <div className={css.toolbar}>
            {active.changedOnDisk && <span className={css.updated}>{copy.updated}</span>}
            {supportsRendered(active.kind) && <>
              <button type="button" data-active={sourceMode || undefined} onClick={() => { setSourceMode(true) }}>{copy.source}</button>
              <button type="button" data-active={!sourceMode || undefined} onClick={() => { setSourceMode(false) }}>{copy.rendered}</button>
            </>}
            {isEditable(active) && <button type="button" data-active={split || undefined} onClick={() => { setSplit(value => !value) }}>{copy.split}</button>}
            <Tooltip label={copy.download} side="bottom" delayMs={400}>
              <button type="button" aria-label={copy.download} disabled={active.content === null} onClick={() => { downloadTab(active) }}><IconDownloadOutline16 size={14} /></button>
            </Tooltip>
            <Tooltip label={copy.refresh} side="bottom" delayMs={400}>
              <button type="button" aria-label={copy.refresh} disabled={active.loading} onClick={() => { onRefresh(active.id) }}><IconRefreshOutline14 /></button>
            </Tooltip>
            {active.dirty && <Button variant="primary" size="sm" disabled={saving} onClick={save}>{copy.save}</Button>}
          </div>
          {saveError !== null && <div className={css.error} role="alert">{saveError}</div>}
          {active.truncated && <div className={css.notice}>{copy.truncated}</div>}
          <div className={css.previewViewport} role="region" aria-label={active.title}>
            <PreviewContent
              tab={active}
              sourceMode={sourceMode}
              split={split}
              ratio={ratio}
              onRatio={setRatio}
              onChange={content => { onChange(active.id, content) }}
              onSave={save}
              copy={copy}
            />
          </div>
        </div>
      )}
      {context !== null && <div className={css.contextMenu} style={{ left: context.x, top: context.y }} onPointerDown={event => { event.stopPropagation() }}>
        <button type="button" onClick={() => { requestClose([context.id]); setContext(null) }}>{copy.close}</button>
        <button type="button" onClick={() => { requestClose(tabs.filter(tab => tab.id !== context.id).map(tab => tab.id)); setContext(null) }}>{copy.closeOthers}</button>
        <button type="button" onClick={() => { requestClose(tabs.map(tab => tab.id)); setContext(null) }}>{copy.closeAll}</button>
      </div>}
      <Modal
        open={closing !== null}
        title={copy.dirtyCloseTitle}
        closeLabel={copy.cancel}
        description={copy.dirtyCloseHint}
        onClose={() => { setClosing(null) }}
        footer={<>
          <Button variant="ghost" onClick={() => { setClosing(null) }}>{copy.cancel}</Button>
          <Button variant="primary" onClick={() => { const ids = closing; setClosing(null); if (ids !== null) onClose(ids) }}>{copy.discard}</Button>
        </>}
      />
    </section>
  )
}

function PreviewContent({ tab, sourceMode, split, ratio, onRatio, onChange, onSave, copy }: {
  readonly tab: PreviewTab
  readonly sourceMode: boolean
  readonly split: boolean
  readonly ratio: number
  readonly onRatio: (ratio: number) => void
  readonly onChange: (content: string) => void
  readonly onSave: () => void
  readonly copy: WorkspacePreviewCopy
}): ReactNode {
  if (tab.loading) return <div className={css.placeholder}>{copy.loading}</div>
  if (tab.error !== null) return <div className={css.placeholder}><strong>{copy.loadFailed}</strong><span>{tab.error}</span></div>
  if (tab.kind === 'office') return <div className={css.placeholder}><strong>{copy.unsupported}</strong><span>{copy.unsupportedHint}</span></div>
  const content = tab.content ?? ''
  if (split && isEditable(tab)) {
    return (
      <div className={css.split}>
        <div className={css.splitSide} style={{ width: `${ratio}%` }}><Editor value={content} onChange={onChange} onSave={onSave} /></div>
        <ResizeHandle ratio={ratio} onRatio={onRatio} />
        <div className={css.splitSide} style={{ width: `${100 - ratio}%` }}><Rendered tab={tab} content={content} copy={copy} /></div>
      </div>
    )
  }
  if (isEditable(tab) && (sourceMode || !supportsRendered(tab.kind))) return <Editor value={content} onChange={onChange} onSave={onSave} />
  return <Rendered tab={tab} content={content} copy={copy} />
}

function Editor({ value, onChange, onSave }: { value: string; onChange: (value: string) => void; onSave: () => void }): ReactNode {
  return <textarea className={css.editor} value={value} spellCheck={false} onChange={event => { onChange(event.currentTarget.value) }} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') { event.preventDefault(); onSave() }
  }} />
}

function Rendered({ tab, content, copy }: { tab: PreviewTab; content: string; copy: WorkspacePreviewCopy }): ReactNode {
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: copy.markdownCopy, copiedLabel: copy.markdownCopied },
    footnotes: copy.markdownFootnotes,
  }), [copy.markdownCopied, copy.markdownCopy, copy.markdownFootnotes])
  if (tab.kind === 'markdown') return <div className={css.markdown}><MarkdownText text={content} labels={labels} /></div>
  if (tab.kind === 'html') return <iframe className={css.frame} srcDoc={content} sandbox="" title={tab.title} />
  if (tab.kind === 'csv') return <CsvPreview content={content} />
  if (tab.kind === 'diff') return <DiffPreview content={content} />
  if (tab.kind === 'image') return (
    <div className={css.image}>
      <HarnessImage
        rootClassName={css.imageComponent}
        imageClassName={css.imageElement}
        src={content}
        alt={tab.title}
        closeLabel={copy.closePreview}
      />
    </div>
  )
  if (tab.kind === 'pdf') return <iframe className={css.frame} src={content} title={tab.title} />
  return <pre className={css.code}><code>{content}</code></pre>
}

function CsvPreview({ content }: { content: string }): ReactNode {
  const rows = useMemo(() => parseCsv(content), [content])
  return <div className={css.csv}><table><tbody>{rows.map((row, rowIndex) => <tr key={`${String(rowIndex)}:${row.join('\u0000')}`}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>
}

function DiffPreview({ content }: { content: string }): ReactNode {
  return <div className={css.diff}>{content.split('\n').map((line, index) => <div key={index} data-kind={diffKind(line)}>{line || ' '}</div>)}</div>
}

function ResizeHandle({ ratio, onRatio }: { ratio: number; onRatio: (ratio: number) => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  return <div ref={ref} className={css.splitHandle} onPointerDown={event => {
    const parent = ref.current?.parentElement
    if (parent === undefined || parent === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent): void => {
      const rect = parent.getBoundingClientRect()
      onRatio(Math.min(80, Math.max(20, ((moveEvent.clientX - rect.left) / rect.width) * 100)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }} style={{ left: `${ratio}%` }} />
}

function usePersistentRatio(): [number, (ratio: number) => void] {
  const [ratio, setRatioState] = useState(() => {
    try { return Math.min(80, Math.max(20, Number(localStorage.getItem('dsh-workbench-preview-split')) || 50)) } catch { return 50 }
  })
  const setRatio = (next: number): void => {
    setRatioState(next)
    try { localStorage.setItem('dsh-workbench-preview-split', String(Math.round(next))) } catch { /* best effort */ }
  }
  return [ratio, setRatio]
}

export function previewKind(path: string): PreviewKind {
  const extension = path.slice(path.lastIndexOf('.')).toLocaleLowerCase()
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  if (extension === '.html' || extension === '.htm') return 'html'
  if (extension === '.csv' || extension === '.tsv') return 'csv'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'].includes(extension)) return 'image'
  if (extension === '.pdf') return 'pdf'
  if (['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(extension)) return 'office'
  if (['.txt', '.log', '.ini', '.cfg'].includes(extension)) return 'text'
  return 'code'
}

export function tabFromFile(snapshot: WorkspaceFileSnapshot): PreviewTab {
  return {
    id: `file:${snapshot.path}`,
    path: snapshot.path,
    title: snapshot.path.slice(snapshot.path.lastIndexOf('/') + 1),
    kind: previewKind(snapshot.path),
    content: snapshot.content,
    mediaType: snapshot.mediaType,
    size: snapshot.size,
    mtime: snapshot.mtime,
    truncated: snapshot.truncated,
    loading: false,
    error: null,
    dirty: false,
    changedOnDisk: false,
  }
}

export function loadingFileTab(path: string): PreviewTab {
  return { id: `file:${path}`, path, title: path.slice(path.lastIndexOf('/') + 1), kind: previewKind(path), content: null, mediaType: '', size: 0, mtime: 0, truncated: false, loading: true, error: null, dirty: false, changedOnDisk: false }
}

export function diffTab(path: string, staged: boolean, content: string | null, loading = false, error: string | null = null): PreviewTab {
  return { id: `diff:${staged ? 'staged' : 'worktree'}:${path}`, path, title: `${path.slice(path.lastIndexOf('/') + 1)} · diff`, kind: 'diff', content, mediaType: 'text/x-diff', size: content?.length ?? 0, mtime: 0, truncated: false, loading, error, dirty: false, changedOnDisk: false, staged }
}

function isEditable(tab: PreviewTab): boolean { return ['markdown', 'html', 'code', 'csv', 'text'].includes(tab.kind) && !tab.truncated }
function supportsRendered(kind: PreviewKind): boolean { return kind === 'markdown' || kind === 'html' || kind === 'csv' }
function diffKind(line: string): string { return line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'meta' }

function downloadTab(tab: PreviewTab): void {
  if (tab.content === null) return
  const anchor = document.createElement('a')
  anchor.download = tab.title
  if (tab.content.startsWith('data:')) anchor.href = tab.content
  else anchor.href = URL.createObjectURL(new Blob([tab.content], { type: tab.mediaType || 'text/plain;charset=utf-8' }))
  anchor.click()
  if (anchor.href.startsWith('blob:')) URL.revokeObjectURL(anchor.href)
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1 }
      else if (character === '"') quoted = false
      else cell += character
    } else if (character === '"') quoted = true
    else if (character === ',') { row.push(cell); cell = '' }
    else if (character === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (character !== '\r') cell += character
  }
  row.push(cell)
  if (row.length > 1 || row[0] !== '') rows.push(row)
  return rows
}
