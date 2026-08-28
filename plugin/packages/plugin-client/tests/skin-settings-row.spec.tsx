// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  MAX_SKIN_BACKGROUND_IMAGE_BYTES, MAX_SKIN_LOGO_IMAGE_BYTES, readSkinImage, readSkinLogo, SkinImageError,
  SkinSettingsRow, type SkinSettingsRowProps,
} from '../src/client/skin/SkinSettingsRow.tsx'
import { skinEn } from '../src/client/locales.ts'
import type { SkinSettings } from '../src/client/skin/skin-controller.ts'

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

describe('SkinSettingsRow', () => {
  it('routes preset, custom brand, enable, and reset choices through its injected actions', () => {
    const props = {
      scope: scopeOf({
        enabled: true,
        preset: 'ink',
        brand: 'desktop',
        backgroundImage: 'data:image/png;base64,AA==',
        transparency: 20,
        logoImage: '',
        brandTitle: '',
        heroHeadline: '',
        heroPreview: '',
      }),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      setPreset: vi.fn().mockResolvedValue(undefined),
      setBackgroundImage: vi.fn().mockResolvedValue(undefined),
      setTransparency: vi.fn().mockResolvedValue(undefined),
      clearBackgroundImage: vi.fn().mockResolvedValue(undefined),
      setLogoImage: vi.fn().mockResolvedValue(undefined),
      clearLogoImage: vi.fn().mockResolvedValue(undefined),
      setBrandTitle: vi.fn().mockResolvedValue(undefined),
      setHeroHeadline: vi.fn().mockResolvedValue(undefined),
      setHeroPreview: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      t: (key: keyof typeof skinEn) => skinEn[key],
    } as unknown as SkinSettingsRowProps

    render(<SkinSettingsRow {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: skinEn.enabled }))
    fireEvent.click(screen.getByRole('button', { name: skinEn['preset.forest'] }))
    const brandTitle = screen.getByRole('textbox', { name: skinEn['brand.title'] })
    fireEvent.change(brandTitle, { target: { value: 'Avilo Lab' } })
    expect(props.setBrandTitle).not.toHaveBeenCalled()
    fireEvent.blur(brandTitle)
    const heroHeadline = screen.getByRole('textbox', { name: skinEn['hero.headline'] })
    fireEvent.change(heroHeadline, { target: { value: 'Chart the unknown' } })
    expect(props.setHeroHeadline).not.toHaveBeenCalled()
    fireEvent.blur(heroHeadline)
    const heroPreview = screen.getByRole('textbox', { name: skinEn['hero.preview'] })
    fireEvent.change(heroPreview, { target: { value: 'Beta' } })
    expect(props.setHeroPreview).not.toHaveBeenCalled()
    fireEvent.blur(heroPreview)
    expect(screen.queryByText('DeepSeek')).toBeNull()
    const transparency = screen.getByRole('slider', { name: skinEn.transparency })
    fireEvent.change(transparency, { target: { value: '45' } })
    fireEvent.pointerUp(transparency)
    fireEvent.click(screen.getByRole('button', { name: skinEn['background.clear'] }))
    fireEvent.click(screen.getByRole('button', { name: skinEn.reset }))

    expect(props.setEnabled).toHaveBeenCalledWith(false)
    expect(props.setPreset).toHaveBeenCalledWith('forest')
    expect(props.setBrandTitle).toHaveBeenCalledWith('Avilo Lab')
    expect(props.setHeroHeadline).toHaveBeenCalledWith('Chart the unknown')
    expect(props.setHeroPreview).toHaveBeenCalledWith('Beta')
    expect(props.setTransparency).toHaveBeenCalledWith(45)
    expect(props.clearBackgroundImage).toHaveBeenCalledOnce()
    expect(props.reset).toHaveBeenCalledOnce()
  })

  it('keeps rapid text edits local and persists only the final value on blur', () => {
    const setBrandTitle = vi.fn().mockResolvedValue(undefined)
    const props = {
      scope: scopeOf({
        enabled: false,
        preset: 'ink',
        brand: 'desktop',
        backgroundImage: '',
        transparency: 20,
        logoImage: '',
        brandTitle: '星织 StarWeave',
        heroHeadline: '连接智能,星织万界',
        heroPreview: '探索版',
      }),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      setPreset: vi.fn().mockResolvedValue(undefined),
      setBackgroundImage: vi.fn().mockResolvedValue(undefined),
      setTransparency: vi.fn().mockResolvedValue(undefined),
      clearBackgroundImage: vi.fn().mockResolvedValue(undefined),
      setLogoImage: vi.fn().mockResolvedValue(undefined),
      clearLogoImage: vi.fn().mockResolvedValue(undefined),
      setBrandTitle,
      setHeroHeadline: vi.fn().mockResolvedValue(undefined),
      setHeroPreview: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      t: (key: keyof typeof skinEn) => skinEn[key],
    } as unknown as SkinSettingsRowProps

    render(<SkinSettingsRow {...props} />)
    const input = screen.getByRole('textbox', { name: skinEn['brand.title'] }) as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '星' } })
    fireEvent.change(input, { target: { value: '星织' } })
    fireEvent.change(input, { target: { value: '星织 Studio' } })

    expect(input.value).toBe('星织 Studio')
    expect(setBrandTitle).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(setBrandTitle).toHaveBeenCalledOnce()
    expect(setBrandTitle).toHaveBeenCalledWith('星织 Studio')
  })

  it('rejects unsupported and oversized background files before reading them', async () => {
    await expect(readSkinImage(new File(['plain'], 'notes.txt', { type: 'text/plain' })))
      .rejects.toMatchObject({ code: 'type' } satisfies Partial<SkinImageError>)
    const oversized = new File([new Uint8Array(MAX_SKIN_BACKGROUND_IMAGE_BYTES + 1)], 'large.png', {
      type: 'image/png',
    })
    await expect(readSkinImage(oversized))
      .rejects.toMatchObject({ code: 'size' } satisfies Partial<SkinImageError>)
  })

  it('rejects animated and oversized logo files before reading them', async () => {
    await expect(readSkinLogo(new File(['gif'], 'animated.gif', { type: 'image/gif' })))
      .rejects.toMatchObject({ code: 'type' } satisfies Partial<SkinImageError>)
    const oversized = new File([new Uint8Array(MAX_SKIN_LOGO_IMAGE_BYTES + 1)], 'large.png', {
      type: 'image/png',
    })
    await expect(readSkinLogo(oversized))
      .rejects.toMatchObject({ code: 'size' } satisfies Partial<SkinImageError>)
  })
})
