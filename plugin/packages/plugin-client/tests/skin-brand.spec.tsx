// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_BRAND_TITLE, SkinBrandMark, SkinBrandName } from '../src/client/skin/SkinBrand.tsx'
import {
  DEFAULT_HERO_HEADLINE, DEFAULT_HERO_PREVIEW, type SkinSettings,
} from '../src/client/skin/skin-controller.ts'

afterEach(cleanup)

function scopeOf(value: SkinSettings): SettingsScope<SkinSettings> {
  const snapshot: SettingsScopeSnapshot<SkinSettings> = {
    status: 'ready', value, base: value, user: value, revision: 1, writable: true, mode: 'host',
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    set: () => Promise.resolve(),
    unset: () => Promise.resolve(),
  }
}

const settings: SkinSettings = {
  enabled: false,
  preset: 'ink',
  brand: 'deepseek',
  backgroundImage: '',
  transparency: 20,
  logoImage: '',
  brandTitle: '',
  heroHeadline: 'Build beyond maps',
  heroPreview: 'Early access',
}

describe('Skin brand presentation', () => {
  it('uses the built-in StarWeave title when no custom sidebar title is stored', () => {
    render(<SkinBrandName scope={scopeOf(settings)} />)
    expect(screen.getByText(DEFAULT_BRAND_TITLE)).toBeTruthy()
  })

  it('uses the built-in StarWeave welcome copy for legacy empty settings', () => {
    const headline = document.createElement('div')
    const mount = document.createElement('span')
    const headlineText = document.createElement('span')
    const preview = document.createElement('span')
    headlineText.textContent = 'Official headline'
    preview.textContent = 'Preview'
    headline.append(mount, headlineText, preview)
    document.body.append(headline)
    const root = createRoot(mount)
    const legacy = { ...settings, heroHeadline: '', heroPreview: '' }

    act(() => {
      root.render(<SkinBrandMark size={34} placement="hero" scope={scopeOf(legacy)} />)
    })
    expect(headlineText.textContent).toBe(DEFAULT_HERO_HEADLINE)
    expect(preview.textContent).toBe(DEFAULT_HERO_PREVIEW)

    act(() => { root.unmount() })
    headline.remove()
  })

  it('replaces and restores only the two Hero copy siblings', () => {
    const headline = document.createElement('div')
    const hitbox = document.createElement('span')
    const slotBoundary = document.createElement('span')
    const mount = document.createElement('span')
    const headlineText = document.createElement('span')
    const preview = document.createElement('span')
    headlineText.textContent = 'Official headline'
    preview.textContent = 'Preview'
    slotBoundary.append(mount)
    hitbox.append(slotBoundary)
    headline.append(hitbox, headlineText, preview)
    document.body.append(headline)
    const root = createRoot(mount)

    act(() => {
      root.render(<SkinBrandMark size={34} placement="hero" scope={scopeOf(settings)} />)
    })
    expect(headline.querySelector('[data-avilo-brand-mark="hero"]')).not.toBeNull()
    expect(headlineText.textContent).toBe('Build beyond maps')
    expect(preview.textContent).toBe('Early access')

    act(() => { root.unmount() })
    expect(headlineText.textContent).toBe('Official headline')
    expect(preview.textContent).toBe('Preview')
    headline.remove()
  })
})
