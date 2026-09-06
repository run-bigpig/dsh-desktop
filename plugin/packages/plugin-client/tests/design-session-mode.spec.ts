import { describe, expect, it, vi } from 'vitest'

import { createDesignSessionMode } from '../src/client/design/session-mode.ts'

describe('design session mode slots', () => {
  it('registers the view only for design sessions and uses the dock only while blank', () => {
    const disposeView = vi.fn()
    const disposeDock = vi.fn()
    const hooks = {
      prepare: vi.fn(),
      registerView: vi.fn(() => disposeView),
      registerDock: vi.fn(() => disposeDock),
    }
    const mode = createDesignSessionMode(hooks)

    mode.sync({ id: 'normal', design: false, blank: true })
    expect(hooks.registerView).not.toHaveBeenCalled()

    mode.sync({ id: 'design-a', design: true, blank: true })
    mode.sync({ id: 'design-a', design: true, blank: true })
    expect(hooks.prepare).toHaveBeenCalledOnce()
    expect(hooks.registerView).toHaveBeenCalledOnce()
    expect(hooks.registerDock).toHaveBeenCalledOnce()

    mode.sync({ id: 'design-a', design: true, blank: false })
    expect(disposeDock).toHaveBeenCalledOnce()
    expect(disposeView).not.toHaveBeenCalled()

    mode.sync({ id: 'normal', design: false, blank: false })
    expect(disposeView).toHaveBeenCalledOnce()
  })

  it('recreates the blank dock after returning from an active design conversation', () => {
    const dockDisposers = [vi.fn(), vi.fn()]
    const hooks = {
      prepare: vi.fn(),
      registerView: vi.fn(() => vi.fn()),
      registerDock: vi.fn(() => dockDisposers.shift() ?? vi.fn()),
    }
    const mode = createDesignSessionMode(hooks)

    mode.sync({ id: 'design-a', design: true, blank: true })
    mode.sync({ id: 'design-a', design: true, blank: false })
    mode.sync({ id: 'design-a', design: true, blank: true })

    expect(hooks.registerDock).toHaveBeenCalledTimes(2)
    expect(hooks.prepare).toHaveBeenCalledOnce()
  })
})
