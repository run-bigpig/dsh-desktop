import { useEffect, useRef, useState } from 'react'
import type { DesignConnection } from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { CanvasResources } from './canvas-resources.ts'
import css from './DesignConversationView.module.css'

export type { DesignConnection }
export interface DesignConversationViewInjected {
  connect: () => Promise<DesignConnection>
  resources: CanvasResources
  visible: boolean
}

export function DesignSurface({ connect, resources, visible }: DesignConversationViewInjected) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let detach: (() => void) | undefined
    setError(null)
    void connect().then(async connection => {
      if (cancelled || !hostRef.current) return
      const mounted = resources.attach(connection, hostRef.current)
      detach = mounted.detach
      await mounted.ready
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true; detach?.() }
  }, [connect, resources, visible, retry])
  return <div className={css.root}>
    <div ref={hostRef} className={css.surface} />
    {error !== null && <div className={css.status} role="alert"><p>{error}</p><button type="button" onClick={() => { setRetry(value => value + 1) }}>重试</button></div>}
  </div>
}
