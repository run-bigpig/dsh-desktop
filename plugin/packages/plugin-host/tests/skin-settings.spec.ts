import { describe, expect, it, vi } from 'vitest'
import {
  registerSkinSettings, SKIN_SETTINGS_NAMESPACE, SkinSettingsSchema,
} from '../src/skin-settings.ts'

describe('desktop skin settings', () => {
  it('provides defaults and rejects unsupported presets or brand values', () => {
    expect(SkinSettingsSchema({})).toEqual({
      enabled: false,
      preset: 'ink',
      brand: 'deepseek',
      backgroundImage: '',
      transparency: 20,
    })
    expect(SkinSettingsSchema({ enabled: true, preset: 'forest', brand: 'desktop' }))
      .toEqual({ enabled: true, preset: 'forest', brand: 'desktop', backgroundImage: '', transparency: 20 })
    expect(() => SkinSettingsSchema({ preset: 'purple-rain' })).toThrow()
    expect(() => SkinSettingsSchema({ brand: 'remote-logo' })).toThrow()
    expect(() => SkinSettingsSchema({ transparency: 81 })).toThrow()
    expect(() => SkinSettingsSchema({ backgroundImage: 'https://example.com/wallpaper.png' })).toThrow()
  })

  it('registers its own settings namespace when the Host settings service is available', () => {
    const register = vi.fn()
    const ctx = {
      inject: (services: readonly string[], callback: (inner: unknown) => void) => {
        expect(services).toEqual(['settings'])
        callback({ settings: { register } })
      },
    }
    registerSkinSettings(ctx as never)
    expect(register).toHaveBeenCalledOnce()
    expect(String(register.mock.calls[0]?.[0])).toBe(SKIN_SETTINGS_NAMESPACE)
    expect(register.mock.calls[0]?.[1]).toBe(SkinSettingsSchema)
  })
})
