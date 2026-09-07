import { describe, expect, it, vi } from 'vitest'

import { createDesignSessionMode } from '../src/client/design/session-mode.ts'

describe('design session mode slots', () => {
  it('leaves blank design sessions untouched and mounts the split after the first message', () => {
    const disposeSplit = vi.fn()
    const hooks = {
      registerSplit: vi.fn(() => disposeSplit),
    }
    const mode = createDesignSessionMode(hooks)

    mode.sync({ id: 'normal', design: false, blank: true })
    expect(hooks.registerSplit).not.toHaveBeenCalled()

    mode.sync({ id: 'design-a', design: true, blank: true })
    mode.sync({ id: 'design-a', design: true, blank: true })
    expect(hooks.registerSplit).not.toHaveBeenCalled()

    mode.sync({ id: 'design-a', design: true, blank: false })
    mode.sync({ id: 'design-a', design: true, blank: false })
    expect(hooks.registerSplit).toHaveBeenCalledOnce()
    expect(disposeSplit).not.toHaveBeenCalled()

    mode.sync({ id: 'normal', design: false, blank: false })
    expect(disposeSplit).toHaveBeenCalledOnce()
  })

  it('removes the split when a design conversation returns to blank', () => {
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const splitDisposers = [firstDispose, secondDispose]
    const hooks = {
      registerSplit: vi.fn(() => splitDisposers.shift() ?? vi.fn()),
    }
    const mode = createDesignSessionMode(hooks)

    mode.sync({ id: 'design-a', design: true, blank: false })
    mode.sync({ id: 'design-a', design: true, blank: true })
    mode.sync({ id: 'design-a', design: true, blank: false })

    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).not.toHaveBeenCalled()
    expect(hooks.registerSplit).toHaveBeenCalledTimes(2)
  })
})
