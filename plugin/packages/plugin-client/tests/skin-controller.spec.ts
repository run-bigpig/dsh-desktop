import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  SKIN_THEME_SOURCE, SKIN_TOKEN_PRESETS, SkinController, skinTokens, type SkinSettings,
} from '../src/client/skin/skin-controller.ts'

class FakeScope implements SettingsScope<SkinSettings> {
  private listeners = new Set<() => void>()
  private snapshot: SettingsScopeSnapshot<SkinSettings> = {
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    mode: 'host',
  }

  getSnapshot = (): SettingsScopeSnapshot<SkinSettings> => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(): Promise<void> { return Promise.resolve() }
  unset(): Promise<void> { return Promise.resolve() }

  publish(value: SkinSettings): void {
    this.snapshot = {
      status: 'ready', value, base: value, user: value, revision: 1, writable: true, mode: 'host',
    }
    for (const listener of this.listeners) listener()
  }
}

describe('SkinController', () => {
  it('applies and fully removes token and background overrides as settings change', () => {
    const scope = new FakeScope()
    const disposeTheme = vi.fn()
    const overrideTokens = vi.fn(() => disposeTheme)
    const setBackgroundImage = vi.fn()
    const controller = new SkinController(scope, { overrideTokens } as never, setBackgroundImage)

    expect(overrideTokens).not.toHaveBeenCalled()
    scope.publish({
      enabled: true,
      preset: 'forest',
      brand: 'desktop',
      backgroundImage: 'data:image/png;base64,AA==',
      transparency: 35,
      logoImage: '',
      brandTitle: '',
      heroHeadline: '',
      heroPreview: '',
    })
    expect(overrideTokens).toHaveBeenCalledWith(SKIN_THEME_SOURCE, skinTokens('forest', 35))
    expect(setBackgroundImage).toHaveBeenLastCalledWith('data:image/png;base64,AA==')

    scope.publish({
      enabled: false,
      preset: 'forest',
      brand: 'desktop',
      backgroundImage: 'data:image/png;base64,AA==',
      transparency: 35,
      logoImage: '',
      brandTitle: '',
      heroHeadline: '',
      heroPreview: '',
    })
    expect(disposeTheme).toHaveBeenCalledOnce()
    expect(setBackgroundImage).toHaveBeenLastCalledWith(undefined)

    controller.dispose()
    expect(disposeTheme).toHaveBeenCalledOnce()
  })

  it('uses only Theme Runtime tokens supported by the pinned Harness contract', () => {
    expect(Object.keys(SKIN_TOKEN_PRESETS.ink)).toEqual([
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-overlay',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-brand-primary',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-specific-sidebar-fill',
    ])
  })

  it('adds transparency only to surface tokens', () => {
    const tokens = skinTokens('ink', 40)
    expect(tokens['--dsw-alias-bg-base']?.light).toContain('60%')
    expect(tokens['--dsw-specific-sidebar-fill']?.dark).toContain('60%')
    expect(tokens['--dsw-alias-label-primary']).toEqual(SKIN_TOKEN_PRESETS.ink['--dsw-alias-label-primary'])
  })
})
