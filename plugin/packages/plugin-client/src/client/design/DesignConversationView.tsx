import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { DesignConnection } from '@run-bigpig/dsh-desktop-plugin-host/types'

import css from './DesignConversationView.module.css'

export type { DesignConnection }

export interface DesignConversationViewInjected { connect: () => Promise<DesignConnection> }
type DesignEmbedHandle = { unmount: () => void }
type DesignEmbedAPI = {
  mount: (element: HTMLElement, options: Pick<DesignConnection, 'baseUrl' | 'sessionId' | 'token'>) => Promise<DesignEmbedHandle>
}
type DesignEmbedModule = { mount?: DesignEmbedAPI['mount'] }

const embedLoads = new Map<string, Promise<DesignEmbedAPI>>()

function DesignSurface({ connect, className }: DesignConversationViewInjected & { className: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let handle: DesignEmbedHandle | undefined
    const mount = async (): Promise<void> => {
      const connection = await connect()
      const baseUrl = new URL(connection.baseUrl)
      if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1') {
        throw new Error('设计画布返回了无效的本地地址')
      }
      const host = hostRef.current
      if (!host || cancelled) return
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
      shadow.replaceChildren()
      const style = document.createElement('link')
      style.rel = 'stylesheet'
      style.href = new URL(connection.stylePath, baseUrl).href
      const surface = document.createElement('div')
      surface.style.width = '100%'
      surface.style.height = '100%'
      shadow.append(style, surface)
      const api = await loadDesignEmbed(new URL(connection.scriptPath, baseUrl).href)
      if (cancelled) return
      const mounted = await api.mount(surface, connection)
      if (cancelled) mounted.unmount()
      else handle = mounted
    }
    void mount().catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      cancelled = true
      handle?.unmount()
    }
  }, [connect])

  return (
    <div className={className}>
      <div ref={hostRef} className={css.surface} />
      {error !== null && <div className={css.status} role="alert">{error}</div>}
    </div>
  )
}

export function DesignConversationSplit({ connect }: DesignConversationViewInjected) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [portal, setPortal] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const scroll = anchor?.closest<HTMLElement>('[data-conversation-scroll]')
    const layout = scroll?.parentElement
    if (!anchor || !scroll || !layout) return
    const restoreTab = markDesignConversationTab(anchor)
    const target = document.createElement('section')
    target.className = css.splitPortal
    target.dataset.starweaveDesignCanvas = ''
    target.setAttribute('aria-label', '设计画布')
    layout.dataset.starweaveDesignLayout = ''
    layout.insertBefore(target, scroll)
    setPortal(target)
    return () => {
      restoreTab()
      target.remove()
      if (layout.querySelector('[data-starweave-design-canvas]') === null) {
        delete layout.dataset.starweaveDesignLayout
      }
    }
  }, [])

  return (
    <>
      <span ref={anchorRef} className={css.splitAnchor} aria-hidden="true" />
      {portal === null ? null : createPortal(
        <DesignSurface connect={connect} className={css.root} />,
        portal,
      )}
    </>
  )
}

function loadDesignEmbed(src: string): Promise<DesignEmbedAPI> {
  const existing = embedLoads.get(src)
  if (existing) return existing
  const promise = import(/* @vite-ignore */ src).then((module: DesignEmbedModule) => {
    if (typeof module.mount !== 'function') throw new Error('设计画布模块未完成初始化')
    return { mount: module.mount }
  }).catch(error => {
    embedLoads.delete(src)
    throw error
  })
  embedLoads.set(src, promise)
  return promise
}

function markDesignConversationTab(anchor: HTMLElement): () => void {
  const conversation = anchor.closest<HTMLElement>('[data-slot="conversation"]')
  const tablist = conversation?.querySelector<HTMLElement>('[role="tablist"]')
  const initial = tablist?.querySelector<HTMLElement>('[role="tab"]')
  if (!tablist || !initial) return () => undefined
  const originalText = initial.textContent
  const originalAria = initial.getAttribute('aria-label')
  const apply = (): void => {
    const tab = tablist.querySelector<HTMLElement>('[role="tab"]')
    if (!tab || tab.textContent === '设计') return
    tab.textContent = '设计'
    tab.setAttribute('aria-label', '设计')
    tab.dataset.starweaveDesignTab = ''
  }
  const observer = new MutationObserver(apply)
  observer.observe(tablist, { childList: true, characterData: true, subtree: true })
  apply()
  return () => {
    observer.disconnect()
    const tab = tablist.querySelector<HTMLElement>('[data-starweave-design-tab]')
    if (!tab) return
    tab.textContent = originalText
    if (originalAria === null) tab.removeAttribute('aria-label')
    else tab.setAttribute('aria-label', originalAria)
    delete tab.dataset.starweaveDesignTab
  }
}
