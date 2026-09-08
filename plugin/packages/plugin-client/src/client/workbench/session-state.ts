import type { StoredImageView, WorkspacePanelRequest, WorkspaceRequest, WorkspacePresentationSnapshot } from '@run-bigpig/dsh-desktop-plugin-host/types'
import { SessionMemory } from './session-memory.ts'

export type WorkbenchTab = 'files' | 'git' | 'image' | 'browser' | 'canvas'
export interface WorkspaceDragPayload {
  readonly sessionId: string
  readonly path: string
  readonly name: string
}
export interface ImageStudioIntent {
  readonly sessionId: string
  readonly sourceImage: StoredImageView
  readonly label: string
  readonly loadImage: () => Promise<string>
}
export interface WorkbenchSession {
  readonly presentation: string | null
  readonly dismissed: readonly string[]
  readonly open: boolean
  readonly tab: WorkbenchTab
  readonly width: number
  readonly followAgent: boolean
  readonly manualSelection: boolean
  readonly manualCollapse: boolean
  readonly task: string | null
  readonly pending: WorkspacePanelRequest | null
  readonly imageIntent: ImageStudioIntent | null
}

type Listener = () => void
export const WORKBENCH_WIDTH_MIN = 360
export const WORKBENCH_WIDTH_DEFAULT = 520
export const WORKBENCH_WIDTH_MAX = 800

const EMPTY: WorkbenchSession = Object.freeze({
  presentation: null, dismissed: [], open: false, tab: 'files', width: WORKBENCH_WIDTH_DEFAULT, followAgent: true,
  manualSelection: false, manualCollapse: false, task: null, pending: null, imageIntent: null,
})
const STORAGE_PREFIX = 'starweave-workbench-session-v1:'
const TABS = new Set<WorkbenchTab>(['files', 'git', 'image', 'browser', 'canvas'])

/** Session ownership is explicit on every action, including background Agent requests. */
export class WorkbenchController {
  private readonly sessions = new Map<string, WorkbenchSession>()
  private readonly resources = new Map<string, Map<string, SessionMemory>>()
  private readonly listeners = new Set<Listener>()
  private readonly interactions = new Map<string, number>()
  private activeSession: string | undefined
  private epoch: string | undefined
  private revision = -1
  private drag: WorkspaceDragPayload | null = null
  private readonly dragListeners = new Set<Listener>()

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSession = (sessionId: string | undefined): WorkbenchSession => {
    if (sessionId === undefined) return EMPTY
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = this.restore(sessionId)
      this.sessions.set(sessionId, session)
    }
    return session
  }

  memory(sessionId: string, resource: string): SessionMemory {
    let resources = this.resources.get(sessionId)
    if (resources === undefined) { resources = new Map(); this.resources.set(sessionId, resources) }
    let memory = resources.get(resource)
    if (memory === undefined) { memory = new SessionMemory(); resources.set(resource, memory) }
    return memory
  }

  toggle(sessionId: string): void {
    this.interacted(sessionId)
    if (this.getSession(sessionId).open) this.close(sessionId)
    else this.select(sessionId, 'files')
  }

  close(sessionId: string): void {
    this.interacted(sessionId)
    const session = this.getSession(sessionId)
    this.update(sessionId, { open: false, manualCollapse: true, dismissed: session.presentation ? [...new Set([...session.dismissed, session.presentation])] : session.dismissed })
  }

  select(sessionId: string, tab: WorkbenchTab): void {
    this.interacted(sessionId)
    if (tab === 'files') for (const memory of this.resources.get(sessionId)?.values() ?? []) memory.set('previewShown', false, false)
    this.update(sessionId, { tab, open: true, manualSelection: true, manualCollapse: false, followAgent: false })
  }

  setActiveSession(sessionId: string | undefined): void {
    this.activeSession = sessionId
  }

  takeOver(sessionId: string): void {
    this.interacted(sessionId)
    this.update(sessionId, { manualSelection: true, followAgent: false })
  }

  follow(sessionId: string, enabled: boolean): void {
    this.interacted(sessionId)
    this.update(sessionId, { followAgent: enabled, manualSelection: !enabled, manualCollapse: false })
    const pending = this.getSession(sessionId).pending
    if (enabled && pending && sessionId === this.activeSession) this.present(pending)
  }

  /** A baseline restores boundaries but never replays old presentation commands. */
  receive(snapshot: WorkspacePresentationSnapshot, foreground = true, interactions = this.captureInteractions()): void {
    const baseline = this.epoch !== snapshot.epoch
    if (!baseline && snapshot.revision <= this.revision) return
    const previousRevision = baseline ? snapshot.revision : this.revision
    this.epoch = snapshot.epoch
    this.revision = snapshot.revision
    for (const entry of snapshot.sessions) {
      const task = `${snapshot.epoch}:${entry.turn}`
      const session = this.getSession(entry.sessionId)
      if (session.task !== task) {
        // A manual action before the initial baseline belongs to that baseline.
        const reset = (session.task !== null || !baseline) && interactions.get(entry.sessionId) === this.interactions.get(entry.sessionId)
        this.update(entry.sessionId, { task, pending: null, ...(reset ? {
          manualSelection: false, manualCollapse: false, followAgent: true, dismissed: [], presentation: null,
        } : {}) })
      }
      if (entry.request && entry.request.revision > previousRevision) this.request(entry.request, foreground && interactions.get(entry.sessionId) === this.interactions.get(entry.sessionId))
    }
  }

  request(request: WorkspaceRequest, foreground = true): boolean {
    if (request.action === 'close') {
      if (request.sessionId !== this.activeSession || !foreground) return false
      this.update(request.sessionId, {
        open: false, pending: null, manualCollapse: false, presentation: null,
      })
      return true
    }
    const session = this.getSession(request.sessionId)
    const cycle = presentationOf(request)
    if (request.sessionId !== this.activeSession || !foreground || session.dismissed.includes(cycle) || (session.presentation === cycle && (session.manualCollapse || session.manualSelection || !session.followAgent))) {
      this.update(request.sessionId, { pending: request })
      return false
    }
    this.present(request)
    return true
  }

  showPending(sessionId: string): void {
    const request = this.getSession(sessionId).pending
    if (request && sessionId === this.activeSession) { this.present(request); this.takeOver(sessionId) }
  }

  private present(request: WorkspacePanelRequest): void {
    const memory = this.memory(request.sessionId, `workspace:${request.cwd}`)
    if (request.panel === 'browser' && request.tabId) memory.set('browser.active', request.tabId, null)
    if (request.panel === 'files' && request.path) this.memory(request.sessionId, `workspace:${request.sessionId}:${request.cwd}`).set('requestedFile', request, null)
    this.update(request.sessionId, { open: true, tab: request.panel, pending: null, manualCollapse: false, manualSelection: false, followAgent: true, presentation: presentationOf(request) })
  }

  openBrowserPage(sessionId: string, cwd: string, tabId: string, interactions: ReadonlyMap<string, number>): void {
    if (sessionId !== this.activeSession || interactions.get(sessionId) !== this.interactions.get(sessionId)) return
    this.memory(sessionId, `workspace:${cwd}`).set('browser.active', tabId, null)
    this.select(sessionId, 'browser')
  }

  openCanvasFile(sessionId: string, interactions: ReadonlyMap<string, number>): void {
    if (sessionId !== this.activeSession || interactions.get(sessionId) !== this.interactions.get(sessionId)) return
    this.select(sessionId, 'canvas')
  }

  resize(sessionId: string, width: number): void {
    if (Number.isFinite(width)) this.update(sessionId, { width: Math.min(WORKBENCH_WIDTH_MAX, Math.max(WORKBENCH_WIDTH_MIN, width)) })
  }

  openImage(intent: ImageStudioIntent): void {
    this.interacted(intent.sessionId)
    this.update(intent.sessionId, { imageIntent: intent, tab: 'image', open: true, manualSelection: true, manualCollapse: false, followAgent: false })
  }

  remove(sessionId: string): void {
    this.interactions.delete(sessionId)
    this.sessions.delete(sessionId)
    this.resources.delete(sessionId)
    try {
      localStorage.removeItem(STORAGE_PREFIX + sessionId)
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(`starweave-workspace-v2:${sessionId}:`)) localStorage.removeItem(key)
      }
    } catch { /* Storage may be unavailable. */ }
    if (this.drag?.sessionId === sessionId) this.endDrag()
    for (const listener of this.listeners) listener()
  }

  readonly subscribeDrag = (listener: Listener): (() => void) => {
    this.dragListeners.add(listener)
    return () => { this.dragListeners.delete(listener) }
  }
  readonly getDrag = (): WorkspaceDragPayload | null => this.drag
  startDrag(payload: WorkspaceDragPayload): void {
    this.drag = payload
    for (const listener of this.dragListeners) listener()
  }
  endDrag(): void {
    if (this.drag === null) return
    this.drag = null
    for (const listener of this.dragListeners) listener()
  }

  captureInteractions(): ReadonlyMap<string, number> {
    return new Map(this.interactions)
  }

  private interacted(sessionId: string): void {
    this.interactions.set(sessionId, (this.interactions.get(sessionId) ?? 0) + 1)
  }

  private update(sessionId: string, change: Partial<WorkbenchSession>): void {
    const previous = this.getSession(sessionId)
    if (Object.entries(change).every(([key, value]) => Object.is(previous[key as keyof WorkbenchSession], value))) return
    const session = { ...previous, ...change }
    this.sessions.set(sessionId, session)
    // Image loaders and attachment content belong to the live session only.
    const { imageIntent: _image, pending: _pending, ...preferences } = session
    try { localStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(preferences)) } catch { /* Keep live state when storage is full/unavailable. */ }
    for (const listener of this.listeners) listener()
  }

  private restore(sessionId: string): WorkbenchSession {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + sessionId) ?? 'null')
      if (raw === null || typeof raw !== 'object') return EMPTY
      const value = raw as Partial<WorkbenchSession>
      return {
        presentation: typeof value.presentation === 'string' ? value.presentation : null,
        dismissed: Array.isArray(value.dismissed) ? value.dismissed.filter((item): item is string => typeof item === 'string') : [],
        open: value.open === true,
        tab: value.tab !== undefined && value.tab !== 'image' && TABS.has(value.tab) ? value.tab : 'files',
        width: typeof value.width === 'number' && Number.isFinite(value.width)
          ? Math.min(WORKBENCH_WIDTH_MAX, Math.max(WORKBENCH_WIDTH_MIN, value.width))
          : WORKBENCH_WIDTH_DEFAULT,
        followAgent: typeof value.task === 'string' ? value.followAgent === true : true,
        manualSelection: typeof value.task === 'string' && value.manualSelection === true,
        manualCollapse: typeof value.task === 'string' && value.manualCollapse === true,
        task: typeof value.task === 'string' ? value.task : null,
        pending: null,
        imageIntent: null,
      }
    } catch { return EMPTY }
  }
}

function presentationOf(request: WorkspacePanelRequest): string {
  return JSON.stringify([request.turn, request.panel, request.tabId ?? request.path ?? '', request.presentation ?? ''])
}
