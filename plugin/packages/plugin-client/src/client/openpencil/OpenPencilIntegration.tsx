import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  OpenPencilClientConnection,
  OpenPencilCollaborationHostSession,
  OpenPencilDesignFile,
  OpenPencilDesignWriteRequest,
  OpenPencilSnapshot,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import { mountOpenPencilSDK } from './sdk-editor.ts'
import css from './OpenPencilIntegration.module.css'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export interface OpenPencilRemote {
  snapshot: () => Promise<RemoteResult<OpenPencilSnapshot>>
  show: () => Promise<RemoteResult<OpenPencilSnapshot>>
  hide: () => Promise<RemoteResult<OpenPencilSnapshot>>
  connection: () => Promise<RemoteResult<OpenPencilClientConnection>>
  canvasKitWasm: () => Promise<RemoteResult<string>>
  fontAsset: (family: string, style: string) => Promise<RemoteResult<string | null>>
  startCollaboration: () => Promise<RemoteResult<OpenPencilCollaborationHostSession>>
  stopCollaboration: (hostKey: string) => Promise<RemoteResult<void>>
  readDesignFile: (sessionId: string, path: string, signal: AbortSignal) => Promise<RemoteResult<OpenPencilDesignFile>>
  writeDesignFile: (
    sessionId: string,
    request: OpenPencilDesignWriteRequest,
    signal: AbortSignal,
  ) => Promise<RemoteResult<{ readonly path: string }>>
}

type Listener = () => void

export class OpenPencilController {
  private snapshot: OpenPencilSnapshot = {
    bundled: true,
    running: false,
    owned: false,
    port: null,
    phase: 'app-stopped',
    mcpConnected: false,
    toolCount: 0,
    visible: false,
    revision: 0,
  }
  private readonly listeners = new Set<Listener>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private connection: OpenPencilClientConnection | undefined
  private wasm: string | undefined
  private sessionId: string | undefined

  constructor(private readonly remote: OpenPencilRemote) {
    void this.refresh()
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): OpenPencilSnapshot => this.snapshot

  async setVisible(visible: boolean): Promise<void> {
    const result = visible ? await this.remote.show() : await this.remote.hide()
    this.update(unwrap(result))
  }

  setSession(sessionId: string | undefined): void {
    this.sessionId = sessionId
  }

  async runtime() {
    this.connection ??= unwrap(await this.remote.connection())
    this.wasm ??= unwrap(await this.remote.canvasKitWasm())
    return {
      ...this.connection,
      canvasKitWasmBase64: this.wasm,
      fontAsset: async (family: string, style: string) => unwrap(await this.remote.fontAsset(family, style)),
      startCollaboration: async () => unwrap(await this.remote.startCollaboration()),
      stopCollaboration: async (hostKey: string) => { unwrap(await this.remote.stopCollaboration(hostKey)) },
      readFile: async (path: string, signal: AbortSignal) =>
        unwrap(await this.remote.readDesignFile(this.requireSession(), path, signal)),
      writeFile: async (path: string, dataBase64: string, signal: AbortSignal) =>
        unwrap(await this.remote.writeDesignFile(this.requireSession(), { path, dataBase64 }, signal)),
      close: () => { void this.setVisible(false) },
    }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.listeners.clear()
  }

  private async refresh(): Promise<void> {
    try {
      this.update(unwrap(await this.remote.snapshot()))
    } catch {
      // A transient remote restart is reflected by the next successful poll.
    } finally {
      if (!this.disposed) this.timer = setTimeout(() => { void this.refresh() }, 750)
    }
  }

  private update(snapshot: OpenPencilSnapshot): void {
    if (JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  private requireSession(): string {
    if (this.sessionId === undefined) throw new Error('请先打开一个 Harness 会话')
    return this.sessionId
  }
}

export interface OpenPencilLauncherInjected {
  readonly controller: OpenPencilController
}

export type OpenPencilLauncherProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<OpenPencilLauncherInjected>

export function OpenPencilLauncher({ controller }: OpenPencilLauncherProps): ReactNode {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return (
    <Tooltip label={snapshot.visible ? '隐藏 OpenPencil' : '打开 OpenPencil'} side="bottom" delayMs={500}>
      <button
        className={css.launcher}
        data-active={snapshot.visible || undefined}
        type="button"
        aria-label={snapshot.visible ? '隐藏 OpenPencil' : '打开 OpenPencil'}
        aria-pressed={snapshot.visible}
        onClick={() => { void controller.setVisible(!snapshot.visible) }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.2 12.8 4 9.4l6.5-6.5a1.4 1.4 0 0 1 2 2L6 11.4l-2.8 1.4Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
          <path d="m9.5 4 2.4 2.4M4 9.4l2 2" stroke="currentColor" strokeWidth="1.25" />
        </svg>
      </button>
    </Tooltip>
  )
}

export interface OpenPencilOverlayInjected {
  readonly controller: OpenPencilController
}

export type OpenPencilOverlayProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<OpenPencilOverlayInjected>

export function OpenPencilOverlay({ controller, useSessions }: OpenPencilOverlayProps): ReactNode {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const current = useSessions(state => state.current)
  const sessionId = current === undefined ? undefined : String(current)
  const hasSession = sessionId !== undefined
  const mountRef = useRef<HTMLDivElement | null>(null)
  const disposeRef = useRef<(() => void) | undefined>()
  const [mounted, setMounted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    controller.setSession(sessionId)
  }, [controller, sessionId])

  useEffect(() => {
    if (!hasSession || mountRef.current === null || disposeRef.current !== undefined) return
    let cancelled = false
    setError(null)
    void controller.runtime().then(async runtime => {
      if (cancelled || mountRef.current === null) return
      const dispose = await mountOpenPencilSDK(mountRef.current, runtime)
      if (cancelled) dispose()
      else {
        disposeRef.current = dispose
        setMounted(true)
      }
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [controller, hasSession])

  useEffect(() => () => { disposeRef.current?.() }, [])

  return (
    <section className={css.overlay} data-visible={snapshot.visible} aria-hidden={!snapshot.visible}>
      <div ref={mountRef} className={css.mount} />
      {!hasSession ? <div className={css.loading}><p>请先打开一个 Harness 会话，再使用 OpenPencil。</p></div> : null}
      {hasSession && error ? <div className={css.loading}><p className={css.error}>{error}</p></div> : null}
      {hasSession && error === null && !mounted ? (
        <div className={css.loading}><span className={css.loadingMark} /><p>正在初始化 OpenPencil SDK…</p></div>
      ) : null}
    </section>
  )
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
