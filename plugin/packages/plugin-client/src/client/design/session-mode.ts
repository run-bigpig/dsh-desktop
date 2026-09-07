export interface DesignSessionState {
  id: string
  design: boolean
  blank: boolean
}

export interface DesignSessionModeHooks {
  registerSplit: () => () => void
}

export function createDesignSessionMode(hooks: DesignSessionModeHooks) {
  let disposeSplit: (() => void) | undefined

  const sync = (session: DesignSessionState | undefined): void => {
    if (!session?.design || session.blank) {
      disposeSplit?.()
      disposeSplit = undefined
      return
    }
    disposeSplit ??= hooks.registerSplit()
  }

  return {
    sync,
    dispose: (): void => {
      disposeSplit?.()
      disposeSplit = undefined
    }
  }
}
