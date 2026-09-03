import { describe, expect, it } from 'vitest'
import Yoga, { initializeOpenPencilYoga } from '../src/client/openpencil/yoga.ts'

describe('OpenPencil Yoga adapter', () => {
  it('hydrates a Config created before the async runtime is initialized', async () => {
    const config = Yoga.Config.create()
    config.setPointScaleFactor(0)

    await initializeOpenPencilYoga()

    const node = Yoga.Node.create(config)
    expect(node).toBeDefined()
    node.free()
  })
})
