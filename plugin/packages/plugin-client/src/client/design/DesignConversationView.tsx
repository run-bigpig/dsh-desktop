import { useEffect, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { DesignConnection } from '@run-bigpig/dsh-desktop-plugin-host/types'

import css from './DesignConversationView.module.css'

export type { DesignConnection }

export interface DesignConversationViewInjected { connect: () => Promise<DesignConnection> }
type DesignEmbedHandle = { unmount: () => void }
type DesignEmbedAPI = {
  mount: (element: HTMLElement, options: Pick<DesignConnection, 'baseUrl' | 'sessionId' | 'token'>) => Promise<DesignEmbedHandle>
}

declare global { interface Window { StarWeaveDesignEmbed?: DesignEmbedAPI } }

const scriptLoads = new Map<string, Promise<void>>()

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
      await loadScript(new URL(connection.scriptPath, baseUrl).href)
      if (cancelled) return
      const api = window.StarWeaveDesignEmbed
      if (!api) throw new Error('设计画布模块未完成初始化')
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

export function DesignConversationView({ connect }: ConvViewProps & DesignConversationViewInjected) {
  return (
    <div className={css.view} data-conversation-composer-overlay="">
      <DesignSurface connect={connect} className={css.root} />
    </div>
  )
}

export function DesignConversationDock({ connect }: DesignConversationViewInjected) {
  return <DesignSurface connect={connect} className={css.dock} />
}

function loadScript(src: string): Promise<void> {
  const existing = scriptLoads.get(src)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = src
    script.async = true
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('无法加载设计画布模块')), { once: true })
    document.head.append(script)
  }).catch(error => {
    scriptLoads.delete(src)
    throw error
  })
  scriptLoads.set(src, promise)
  return promise
}
