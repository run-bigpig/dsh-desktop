import { useLayoutEffect, useRef, useState } from 'react'
import type { DesignConnection } from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { CanvasResources } from './canvas-resources.ts'
import css from './DesignConversationView.module.css'
import { LoadingCover } from '../workbench/LoadingCover.tsx'

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
  const [loading, setLoading] = useState(true)
  useLayoutEffect(() => {
    if (hostRef.current) hostRef.current.inert = loading || !visible
  }, [loading, visible])
  useLayoutEffect(() => {
    if (!visible) return
    let cancelled = false
    let detach: (() => void) | undefined
    setError(null)
    setLoading(true)
    void connect().then(async connection => {
      if (cancelled || !hostRef.current) return
      const mounted = resources.attach(connection, hostRef.current)
      detach = mounted.detach
      await mounted.ready
      if (!cancelled) setLoading(false)
    }).catch(reason => {
      if (!cancelled) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false) }
    })
    return () => { cancelled = true; detach?.() }
  }, [connect, resources, visible, retry])
  return <div className={css.root} aria-busy={loading && visible}>
    <div ref={hostRef} className={css.surface} />
    <LoadingCover loading={loading && visible} label="正在打开画布…" />
    {error !== null && <div className={css.status} role="alert"><p>{error}</p><button type="button" onClick={() => { setRetry(value => value + 1) }}>重试</button></div>}
  </div>
}
