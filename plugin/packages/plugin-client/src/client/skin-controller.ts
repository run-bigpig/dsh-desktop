import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemeRuntime, ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

export const SKIN_SETTINGS_NAMESPACE = 'desktop-skin'
export const SKIN_THEME_SOURCE = '@run-bigpig/dsh-desktop-plugin-client/skin'

export const SKIN_PRESETS = ['ink', 'forest', 'sand'] as const
export const SKIN_BRANDS = ['deepseek', 'desktop'] as const

export type SkinPreset = typeof SKIN_PRESETS[number]
export type SkinBrand = typeof SKIN_BRANDS[number]

export interface SkinSettings {
  enabled: boolean
  preset: SkinPreset
  brand: SkinBrand
  backgroundImage: string
  transparency: number
}

export const DEFAULT_SKIN_SETTINGS: Readonly<SkinSettings> = Object.freeze({
  enabled: false,
  preset: 'ink',
  brand: 'deepseek',
  backgroundImage: '',
  transparency: 20,
})

export const SKIN_TOKEN_PRESETS: Readonly<Record<SkinPreset, ThemeTokenOverrides>> = Object.freeze({
  ink: Object.freeze({
    '--dsw-alias-bg-base': { light: '#f4f6f8', dark: '#10151c' },
    '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#161d26' },
    '--dsw-alias-bg-layer-2': { light: '#edf1f5', dark: '#1c2530' },
    '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#202a36' },
    '--dsw-alias-border-l1': { light: 'rgba(22, 34, 50, 0.08)', dark: 'rgba(255, 255, 255, 0.07)' },
    '--dsw-alias-border-l2': { light: 'rgba(22, 34, 50, 0.16)', dark: 'rgba(255, 255, 255, 0.13)' },
    '--dsw-alias-brand-primary': { light: '#263b59', dark: '#a9c7ee' },
    '--dsw-alias-label-primary': { light: '#172334', dark: '#edf4fc' },
    '--dsw-alias-label-secondary': { light: '#526071', dark: '#aebaca' },
    '--dsw-specific-sidebar-fill': { light: '#e9eef3', dark: '#0c1118' },
  }),
  forest: Object.freeze({
    '--dsw-alias-bg-base': { light: '#f4f7f1', dark: '#111a15' },
    '--dsw-alias-bg-layer-1': { light: '#fcfdf9', dark: '#17231c' },
    '--dsw-alias-bg-layer-2': { light: '#e9f0e8', dark: '#1d2c23' },
    '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#223229' },
    '--dsw-alias-border-l1': { light: 'rgba(38, 77, 55, 0.08)', dark: 'rgba(211, 235, 219, 0.07)' },
    '--dsw-alias-border-l2': { light: 'rgba(38, 77, 55, 0.16)', dark: 'rgba(211, 235, 219, 0.14)' },
    '--dsw-alias-brand-primary': { light: '#2d664b', dark: '#91c9a8' },
    '--dsw-alias-label-primary': { light: '#20372c', dark: '#edf7f0' },
    '--dsw-alias-label-secondary': { light: '#5c6f63', dark: '#aec2b4' },
    '--dsw-specific-sidebar-fill': { light: '#e5ede3', dark: '#0d1511' },
  }),
  sand: Object.freeze({
    '--dsw-alias-bg-base': { light: '#f8f3ea', dark: '#1d1712' },
    '--dsw-alias-bg-layer-1': { light: '#fffaf2', dark: '#271f18' },
    '--dsw-alias-bg-layer-2': { light: '#f1e7d8', dark: '#31271e' },
    '--dsw-alias-bg-overlay': { light: '#fffaf2', dark: '#352a20' },
    '--dsw-alias-border-l1': { light: 'rgba(91, 59, 35, 0.08)', dark: 'rgba(246, 224, 197, 0.07)' },
    '--dsw-alias-border-l2': { light: 'rgba(91, 59, 35, 0.16)', dark: 'rgba(246, 224, 197, 0.14)' },
    '--dsw-alias-brand-primary': { light: '#985f32', dark: '#e3b37f' },
    '--dsw-alias-label-primary': { light: '#3e2d20', dark: '#f6eadd' },
    '--dsw-alias-label-secondary': { light: '#746252', dark: '#c9b7a5' },
    '--dsw-specific-sidebar-fill': { light: '#efe2d0', dark: '#17110d' },
  }),
})

type ThemeFace = Pick<ThemeRuntime, 'overrideTokens'>

const TRANSPARENT_SURFACE_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-specific-sidebar-fill',
])

/** Add transparency only to surface colors; text, accents, and borders stay readable. */
export function skinTokens(preset: SkinPreset, transparency: number): ThemeTokenOverrides {
  const tokens = SKIN_TOKEN_PRESETS[preset]
  if (transparency <= 0) return tokens
  const visible = Math.max(20, 100 - Math.min(80, Math.round(transparency)))
  return Object.fromEntries(Object.entries(tokens).map(([name, modes]) => [
    name,
    TRANSPARENT_SURFACE_TOKENS.has(name)
      ? {
          light: `color-mix(in srgb, ${modes.light} ${visible}%, transparent)`,
          dark: `color-mix(in srgb, ${modes.dark} ${visible}%, transparent)`,
        }
      : modes,
  ]))
}

/** Keep Theme Runtime and brand Slot occupants synchronized with persisted settings. */
export class SkinController {
  private unsubscribe: (() => void) | undefined
  private disposeTheme: (() => void) | undefined
  private appliedTheme = ''
  private customBrand = false
  private backgroundImage: string | undefined

  constructor(
    private readonly scope: SettingsScope<SkinSettings>,
    private readonly theme: ThemeFace,
    private readonly setCustomBrand: (enabled: boolean) => void,
    private readonly setBackgroundImage: (image: string | undefined) => void,
  ) {
    this.unsubscribe = scope.subscribe(() => { this.sync() })
    this.sync()
  }

  private sync(): void {
    const snapshot = this.scope.getSnapshot()
    const settings = snapshot.status === 'ready' ? snapshot.value : undefined
    const themeKey = settings?.enabled === true ? `${settings.preset}:${settings.transparency}` : ''
    if (themeKey !== this.appliedTheme) {
      this.disposeTheme?.()
      this.disposeTheme = settings?.enabled !== true
        ? undefined
        : this.theme.overrideTokens(SKIN_THEME_SOURCE, skinTokens(settings.preset, settings.transparency))
      this.appliedTheme = themeKey
    }

    const customBrand = settings?.brand === 'desktop'
    if (customBrand !== this.customBrand) {
      this.setCustomBrand(customBrand)
      this.customBrand = customBrand
    }

    const backgroundImage = settings?.enabled === true && settings.backgroundImage !== ''
      ? settings.backgroundImage
      : undefined
    if (backgroundImage !== this.backgroundImage) {
      this.setBackgroundImage(backgroundImage)
      this.backgroundImage = backgroundImage
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.disposeTheme?.()
    this.disposeTheme = undefined
    this.appliedTheme = ''
    if (this.customBrand) this.setCustomBrand(false)
    this.customBrand = false
    if (this.backgroundImage !== undefined) this.setBackgroundImage(undefined)
    this.backgroundImage = undefined
  }
}
