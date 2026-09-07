import { useCallback, useMemo, useRef, useLayoutEffect, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'

/** Owned by the plugin/session, not by Harness's session-keyed details mount. */
export class SessionMemory {
  private readonly values = new Map<string, unknown>()
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get<T>(key: string, initial: T | (() => T)): T {
    if (!this.values.has(key)) this.values.set(key, typeof initial === 'function' ? (initial as () => T)() : initial)
    return this.values.get(key) as T
  }

  set<T>(key: string, update: SetStateAction<T>, initial: T | (() => T)): void {
    const previous = this.get(key, initial)
    const next = typeof update === 'function' ? (update as (value: T) => T)(previous) : update
    if (Object.is(previous, next)) return
    this.values.set(key, next)
    for (const listener of this.listeners) listener()
  }
}

export function useSessionState<T>(memory: SessionMemory | undefined, key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const local = useMemo(() => new SessionMemory(), [])
  const owner = memory ?? local
  const value = useSyncExternalStore(owner.subscribe, () => owner.get(key, initial))
  const set = useCallback((update: SetStateAction<T>) => { owner.set(key, update, initial) }, [owner, key])
  return [value, set]
}

/** Scroll positions are stored outside the session-keyed details DOM. */
export function useSessionScroll(memory: SessionMemory | undefined, key: string, visible = true) {
  const local = useMemo(() => new SessionMemory(), [])
  const owner = memory ?? local
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!visible || !root.current) return
    const element = root.current
    const positions = owner.get<Record<string, { top: number; left: number }>>(key, {})
    const restore = (): void => {
      for (const target of element.querySelectorAll<HTMLElement>('[data-workspace-scroll]')) {
        const position = positions[target.dataset.workspaceScroll!]
        if (position) { target.scrollTop = position.top; target.scrollLeft = position.left }
      }
    }
    restore()
    const observer = new MutationObserver(restore)
    observer.observe(element, { childList: true, subtree: true })
    const remember = (event: Event): void => {
      const target = event.target
      if (target instanceof HTMLElement && target.dataset.workspaceScroll) {
        positions[target.dataset.workspaceScroll] = { top: target.scrollTop, left: target.scrollLeft }
      }
    }
    element.addEventListener('scroll', remember, true)
    return () => { observer.disconnect(); element.removeEventListener('scroll', remember, true) }
  }, [owner, key, visible])
  return root
}
