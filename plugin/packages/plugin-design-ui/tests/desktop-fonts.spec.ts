// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

const manager = vi.hoisted(() => ({ markLoaded: vi.fn(), setCJKFallbackFamily: vi.fn(), loadedData: vi.fn() }))
vi.mock('@open-pencil/core/text', () => ({ fontManager: manager }))
afterEach(() => {
  Reflect.deleteProperty(window, '__STARWEAVE_DESIGN_FONTS__')
  vi.resetModules()
  vi.clearAllMocks()
})

it('accepts late Wails injection and loads the same font only once across mounts', async () => {
  const fonts = await import('../src/desktop-fonts.ts')
  await fonts.loadDesktopFonts()
  expect(manager.markLoaded).not.toHaveBeenCalled()
  const data = new ArrayBuffer(4)
  const load = vi.fn().mockResolvedValue(data)
  Object.defineProperty(window, '__STARWEAVE_DESIGN_FONTS__', { configurable: true, value: { family: 'SimHei', load } })
  await Promise.all([fonts.loadDesktopFonts(), fonts.loadDesktopFonts()])
  expect(load).toHaveBeenCalledTimes(1)
  expect(manager.markLoaded).toHaveBeenCalledWith('SimHei', 'Regular', data)
  expect(manager.setCJKFallbackFamily).toHaveBeenCalledWith('SimHei')
  expect(await fonts.loadDesktopFont('Inter', 'Regular')).toBeNull()
  expect(await fonts.loadDesktopFont('SimHei', 'Bold')).toBeNull()
})

it('allows a failed font load to retry instead of caching failure through the session', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('font unavailable')).mockResolvedValue(new ArrayBuffer(4))
  Object.defineProperty(window, '__STARWEAVE_DESIGN_FONTS__', { configurable: true, value: { family: 'SimHei', load } })
  const fonts = await import('../src/desktop-fonts.ts')
  await expect(fonts.loadDesktopFonts()).rejects.toThrow('font unavailable')
  expect(manager.setCJKFallbackFamily).not.toHaveBeenCalled()
  await fonts.loadDesktopFonts()
  expect(manager.setCJKFallbackFamily).toHaveBeenCalledWith('SimHei')
})
