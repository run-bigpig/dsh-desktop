import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopWindowState } from '@run-bigpig/dsh-desktop-plugin-host/types'
import css from './DesktopWindowControls.module.css'

export interface DesktopWindowControlsInjected {
  windowState: () => Promise<DesktopWindowState>
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<DesktopWindowState>
  closeWindow: () => Promise<void>
}

export type DesktopWindowControlsProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'desktop.integration'>
  & DesktopWindowControlsInjected

const CHROME_FRAME_CLASS = 'dsh-desktop-chrome-frame'
const SIDEBAR_WIDTH_PROPERTY = '--dsh-desktop-sidebar-width'

export function DesktopWindowControls({
  closeWindow,
  minimizeWindow,
  toggleMaximizeWindow,
  windowState,
  t,
}: DesktopWindowControlsProps): ReactNode {
  const [state, setState] = useState<DesktopWindowState>({ maximized: false, fullscreen: false })
  const chromeRef = useRef<HTMLDivElement | null>(null)

  const report = useCallback((action: string, error: unknown): void => {
    console.error(`[desktop-integration] ${action} failed:`, error)
  }, [])

  const refresh = useCallback(() => {
    void windowState().then(setState, error => {
      console.error('[desktop-integration] reading window state failed:', error)
    })
  }, [windowState])

  useEffect(() => {
    refresh()
    const onResize = (): void => { refresh() }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [refresh])

  useLayoutEffect(() => {
    if (state.fullscreen) return
    const frame = chromeRef.current?.closest<HTMLElement>('[data-shell-overlay]')?.parentElement
    if (frame === undefined || frame === null) return
    const sidebar = frame.firstElementChild
    if (!(sidebar instanceof HTMLElement)) return
    const updateSidebarWidth = (): void => {
      frame.style.setProperty(SIDEBAR_WIDTH_PROPERTY, `${sidebar.getBoundingClientRect().width}px`)
    }
    frame.classList.add(CHROME_FRAME_CLASS)
    updateSidebarWidth()
    const observer = new ResizeObserver(updateSidebarWidth)
    observer.observe(sidebar)
    return () => {
      observer.disconnect()
      frame.classList.remove(CHROME_FRAME_CLASS)
      frame.style.removeProperty(SIDEBAR_WIDTH_PROPERTY)
    }
  }, [state.fullscreen])

  if (state.fullscreen) return null

  return (
    <div ref={chromeRef} className={css.desktopChrome} data-desktop-window-controls>
      <div className={css.dragRegion} aria-hidden="true" />
      <div className={css.controls} role="group" aria-label={t('windowControls')}>
        <button
          type="button"
          aria-label={t('minimize')}
          title={t('minimize')}
          onClick={() => { void minimizeWindow().catch(error => { report('minimizing the window', error) }) }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5h8" /></svg>
        </button>
        <button
          type="button"
          aria-label={t(state.maximized ? 'restore' : 'maximize')}
          title={t(state.maximized ? 'restore' : 'maximize')}
          onClick={() => {
            void toggleMaximizeWindow().then(setState, error => { report('resizing the window', error) })
          }}
        >
          {state.maximized
            ? <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 4.5h5v5h-5zM5 2.5h4.5V7" /></svg>
            : <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" /></svg>}
        </button>
        <button
          className={css.close}
          type="button"
          aria-label={t('close')}
          title={t('close')}
          onClick={() => { void closeWindow().catch(error => { report('closing the window', error) }) }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg>
        </button>
      </div>
    </div>
  )
}
