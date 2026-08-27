// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  MAX_SKIN_BACKGROUND_IMAGE_BYTES, readSkinImage, SkinImageError, SkinSettingsRow, type SkinSettingsRowProps,
} from '../src/client/SkinSettingsRow.tsx'
import { skinEn } from '../src/client/locales.ts'
import type { SkinSettings } from '../src/client/skin-controller.ts'

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
  it('routes preset, brand, enable, and reset choices through its injected actions', () => {
    const props = {
      scope: scopeOf({
        enabled: true,
        preset: 'ink',
        brand: 'deepseek',
        backgroundImage: 'data:image/png;base64,AA==',
        transparency: 20,
      }),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      setPreset: vi.fn().mockResolvedValue(undefined),
      setBrand: vi.fn().mockResolvedValue(undefined),
      setBackgroundImage: vi.fn().mockResolvedValue(undefined),
      setTransparency: vi.fn().mockResolvedValue(undefined),
      clearBackgroundImage: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      t: (key: keyof typeof skinEn) => skinEn[key],
    } as unknown as SkinSettingsRowProps

    render(<SkinSettingsRow {...props} />)
    fireEvent.click(screen.getByRole('checkbox', { name: skinEn.enabled }))
    fireEvent.click(screen.getByRole('button', { name: skinEn['preset.forest'] }))
    fireEvent.click(screen.getByRole('button', { name: skinEn['brand.desktop'] }))
    const transparency = screen.getByRole('slider', { name: skinEn.transparency })
    fireEvent.change(transparency, { target: { value: '45' } })
    fireEvent.pointerUp(transparency)
    fireEvent.click(screen.getByRole('button', { name: skinEn['background.clear'] }))
    fireEvent.click(screen.getByRole('button', { name: skinEn.reset }))

    expect(props.setEnabled).toHaveBeenCalledWith(false)
    expect(props.setPreset).toHaveBeenCalledWith('forest')
    expect(props.setBrand).toHaveBeenCalledWith('desktop')
    expect(props.setTransparency).toHaveBeenCalledWith(45)
    expect(props.clearBackgroundImage).toHaveBeenCalledOnce()
    expect(props.reset).toHaveBeenCalledOnce()
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
})
