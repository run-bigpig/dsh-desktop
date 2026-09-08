import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { BrowserCommand, BrowserTab } from '@run-bigpig/dsh-desktop-plugin-host/types'
import { useSessionState, type SessionMemory } from './session-memory.ts'
import type { WorkbenchDrawerProps } from './SessionWorkbench.tsx'
import css from './BrowserWorkbench.module.css'
import { LoadingCover } from './LoadingCover.tsx'

export type BrowserActions = (request: BrowserCommand, signal: AbortSignal) => Promise<string>
let layoutSequence = 0

export function nextBrowserLayoutSequence(): number {
  // A reloaded/temporary client must not permanently outrank the desktop page.
  layoutSequence = Math.max(Date.now(), layoutSequence + 1)
  return layoutSequence
}

export function BrowserWorkbench({ memory, visible, command, t }: {
  memory: SessionMemory; visible: boolean; command: BrowserActions; t: WorkbenchDrawerProps['t']
}): ReactNode {
  const [tabs, setTabs] = useSessionState<readonly BrowserTab[]>(memory, 'browser.tabs', [])
  const [activeId, setActiveId] = useSessionState<string | null>(memory, 'browser.active', null)
  const [error, setError] = useState<string | null>(null)
  const [pagesOpen, setPagesOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [listed, setListed] = useState(tabs.length > 0)
  const [presentedId, setPresentedId] = useState<string | null>(null)
  const [layoutRetry, setLayoutRetry] = useState(0)
  const viewport = useRef<HTMLDivElement>(null)
  const active = tabs.find(tab => tab.id === activeId) ?? null
  const [address, setAddress] = useSessionState(memory, `browser.address:${activeId}`, active?.url === 'about:blank' ? '' : active?.url ?? '')
  const sync = useCallback(async (signal: AbortSignal): Promise<void> => {
    const selection = memory.get<string | null>('browser.active', null)
    const revision = memory.get('browser.syncRevision', 0) + 1
    memory.set('browser.syncRevision', revision, 0)
    const result = JSON.parse(await command({ op: 'list' }, signal)) as BrowserTab[]
    if (signal.aborted || memory.get('browser.syncRevision', 0) !== revision || memory.get('browser.active', null) !== selection) return
    const previous = memory.get<readonly BrowserTab[]>('browser.tabs', [])
    const byId = new Map(result.map(tab => [tab.id, tab]))
    const ordered = [...previous.flatMap(tab => byId.has(tab.id) ? [byId.get(tab.id)!] : []), ...result.filter(tab => !previous.some(old => old.id === tab.id))]
    setTabs(ordered)
    setListed(true)
    setActiveId(current => {
      if (ordered.some(tab => tab.id === current)) return current
      const removedIndex = previous.findIndex(tab => tab.id === current)
      return ordered[Math.min(Math.max(removedIndex, 0), ordered.length - 1)]?.id ?? null
    })
  }, [command, memory, setTabs, setActiveId])

  useEffect(() => {
    if (!visible) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try { await sync(abort.signal) } catch (reason) { if (!abort.signal.aborted) setError(messageOf(reason)) }
      if (!abort.signal.aborted) timer = setTimeout(() => { void poll() }, 1500)
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [visible, sync])
  useEffect(() => {
    const key = `browser.address-url:${activeId}`
    if (memory.get(key, active?.url) !== active?.url) setAddress(active?.url === 'about:blank' ? '' : active?.url ?? '')
    memory.set(key, active?.url, undefined)
  }, [activeId, active?.url, memory, setAddress])

  useLayoutEffect(() => {
    const target = viewport.current
    setPresentedId(null)
    if (!visible || !target || !active) return
    const tabId = active.id
    let stopped = false
    let frame = 0
    let preparing = true
    let last = ''
    const publish = async (force = false): Promise<void> => {
      frame = 0
      if (stopped || preparing) return
      const bounds = target.getBoundingClientRect()
      const overlay = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], dialog[open], .dsh-image-preview-root')]
        .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      const shown = !overlay && document.visibilityState !== 'hidden' && bounds.width > 0 && bounds.height > 0
      const request: BrowserCommand = { op: 'layout', tabId, visible: shown,
        bounds: { x: Math.max(0, bounds.x), y: Math.max(0, bounds.y), width: bounds.width, height: bounds.height, scale: window.devicePixelRatio || 1 } }
      const signature = JSON.stringify(request)
      if (!force && signature === last) return
      last = signature
      try {
        await command({ ...request, sequence: nextBrowserLayoutSequence() }, AbortSignal.timeout(5000))
        if (!stopped && shown) setPresentedId(tabId)
      }
      catch (reason) { if (!stopped) { last = ''; setError(messageOf(reason)) } }
    }
    const schedule = (): void => { if (!frame && !preparing && !stopped) frame = requestAnimationFrame(() => { void publish() }) }
    const resize = new ResizeObserver(schedule)
    resize.observe(target)
    const overlays = new MutationObserver(schedule)
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-hidden'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    document.addEventListener('visibilitychange', schedule)
    const heartbeat = setInterval(() => { void publish(true) }, 1000)
    // Native child windows cannot be covered by a DOM loading layer. Hide the
    // target first, then position and show it after the details layout commits.
    void command({ op: 'layout', tabId, visible: false, sequence: nextBrowserLayoutSequence() }, AbortSignal.timeout(5000)).then(() => {
      if (stopped) return
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => { preparing = false; void publish() })
      })
    }).catch(reason => { if (!stopped) setError(messageOf(reason)) })
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      resize.disconnect(); overlays.disconnect(); clearInterval(heartbeat)
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true)
      document.removeEventListener('visibilitychange', schedule)
      void command({ op: 'layout', tabId, visible: false, sequence: nextBrowserLayoutSequence() }, AbortSignal.timeout(5000)).catch(() => {})
    }
  }, [visible, active?.id, command, layoutRetry])

  const run = async (request: BrowserCommand): Promise<void> => {
    const selection = memory.get<string | null>('browser.active', null)
    // Invalidate an older poll before this mutation changes the tab set.
    memory.set('browser.syncRevision', value => value + 1, 0)
    setBusy(true); setError(null)
    try {
      const result = JSON.parse(await command(request, AbortSignal.timeout(30000))) as BrowserTab
      if (request.op === 'create' && memory.get('browser.active', null) === selection) {
        setTabs(current => [...current.filter(tab => tab.id !== result.id), result])
        setActiveId(result.id)
      }
      await sync(AbortSignal.timeout(10000))
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  const navigate = (): void => {
    const raw = address.trim()
    if (!raw) return
    const url = /^[a-z][a-z\d+.-]*:/iu.test(raw) ? raw : `https://${raw}`
    void run(active ? { op: 'navigate', tabId: active.id, url } : { op: 'create', tabId: crypto.randomUUID(), url })
  }
  const loading = visible && error === null && (!listed || (active ? presentedId !== active.id : busy))
  return <div className={css.browser}>
    <div className={css.pages}>
      <Menu open={pagesOpen} items={tabs.map(tab => ({ id: tab.id, label: tab.title || tab.url }))}
        selectedId={activeId ?? undefined} portal compact align="start"
        onClose={() => { setPagesOpen(false) }} onSelect={id => { setActiveId(id); setPagesOpen(false) }}
        anchor={<button className={css.pagePicker} type="button" aria-label={t('browserPages')} aria-haspopup="menu" aria-expanded={pagesOpen} disabled={!tabs.length} onClick={() => { setPagesOpen(value => !value) }}>{active?.title || active?.url || t('browser')} ▾ <small>{tabs.length || ''}</small></button>}
      />
      <button type="button" aria-label={t('newBrowserTab')} disabled={busy} onClick={() => { void run({ op: 'create', tabId: crypto.randomUUID(), url: 'about:blank' }) }}>＋</button>
      <button type="button" aria-label={t('closeTab')} disabled={busy || !active} onClick={() => { if (active) void run({ op: 'close', tabId: active.id }) }}>×</button>
    </div>
    <form className={css.navigation} onSubmit={event => { event.preventDefault(); navigate() }}>
      <button type="button" aria-label={t('browserBack')} disabled={!active?.canGoBack || busy} onClick={() => { void run({ op: 'back', tabId: active!.id }) }}>←</button>
      <button type="button" aria-label={t('browserForward')} disabled={!active?.canGoForward || busy} onClick={() => { void run({ op: 'forward', tabId: active!.id }) }}>→</button>
      <button type="button" aria-label={t('browserRefresh')} disabled={!active || busy} onClick={() => { void run({ op: 'reload', tabId: active!.id }) }}>↻</button>
      <input aria-label={t('browserAddress')} placeholder={t('browserAddress')} value={address} onChange={event => { setAddress(event.target.value) }} />
      <button type="submit" disabled={busy || !address.trim()}>{t('browserGo')}</button>
    </form>
    {error !== null && <div role="alert" className={css.error}>{error}<button type="button" onClick={() => { setError(null); setLayoutRetry(value => value + 1); void sync(AbortSignal.timeout(10000)).catch(reason => { setError(messageOf(reason)) }) }}>{t('retry')}</button></div>}
    <div ref={viewport} className={css.viewport} aria-label={t('browser')} aria-busy={loading}>
      {!active && !loading && <p className={css.empty}>{t('browserEmpty')}</p>}
      <LoadingCover loading={loading} label={t('browserLoading')} />
    </div>
  </div>
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
