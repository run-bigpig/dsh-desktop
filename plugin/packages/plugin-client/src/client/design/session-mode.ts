export interface DesignSessionState {
  id: string
  design: boolean
  blank: boolean
}

export interface DesignSessionModeHooks {
  prepare: (sessionId: string) => void
  registerView: () => () => void
  registerDock: () => () => void
}

export function createDesignSessionMode(hooks: DesignSessionModeHooks) {
  const prepared = new Set<string>()
  let disposeView: (() => void) | undefined
  let disposeDock: (() => void) | undefined

  const sync = (session: DesignSessionState | undefined): void => {
    if (!session?.design) {
      disposeView?.()
      disposeDock?.()
      disposeView = undefined
      disposeDock = undefined
      return
    }
    if (!prepared.has(session.id)) {
      prepared.add(session.id)
      hooks.prepare(session.id)
    }
    disposeView ??= hooks.registerView()
    if (session.blank) {
      disposeDock ??= hooks.registerDock()
    } else if (disposeDock) {
      disposeDock()
      disposeDock = undefined
    }
  }

  return {
    sync,
    dispose: (): void => {
      disposeView?.()
      disposeDock?.()
      disposeView = undefined
      disposeDock = undefined
    }
  }
}
