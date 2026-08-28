import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const SKIN_SETTINGS_NAMESPACE = 'desktop-skin'
export const SKIN_PRESETS = ['ink', 'forest', 'sand'] as const
export const SKIN_BRANDS = ['deepseek', 'desktop'] as const

export type SkinPreset = typeof SKIN_PRESETS[number]
export type SkinBrand = typeof SKIN_BRANDS[number]

const DEFAULT_BRAND_TITLE = '星织 StarWeave'
const DEFAULT_HERO_HEADLINE = '连接智能,星织万界'
const DEFAULT_HERO_PREVIEW = '探索版'

export interface SkinSettings {
  enabled: boolean
  preset: SkinPreset
  brand: SkinBrand
  backgroundImage: string
  transparency: number
  logoImage: string
  brandTitle: string
  heroHeadline: string
  heroPreview: string
}

const MAX_BACKGROUND_IMAGE_DATA_URL_CHARS = 7_000_000
const BACKGROUND_IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,/
const MAX_LOGO_IMAGE_DATA_URL_CHARS = 1_400_000
const LOGO_IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp|avif);base64,/

export const SkinSettingsSchema: z<SkinSettings> = z.object({
  enabled: z.boolean().default(false),
  preset: z.union([...SKIN_PRESETS]).default('ink'),
  brand: z.union([...SKIN_BRANDS]).default('desktop'),
  backgroundImage: z.union([
    '',
    z.string().max(MAX_BACKGROUND_IMAGE_DATA_URL_CHARS).pattern(BACKGROUND_IMAGE_DATA_URL_PATTERN),
  ]).default(''),
  transparency: z.number().step(1).min(0).max(80).default(20),
  logoImage: z.union([
    '',
    z.string().max(MAX_LOGO_IMAGE_DATA_URL_CHARS).pattern(LOGO_IMAGE_DATA_URL_PATTERN),
  ]).default(''),
  brandTitle: z.string().max(32).default(DEFAULT_BRAND_TITLE),
  heroHeadline: z.string().max(48).default(DEFAULT_HERO_HEADLINE),
  heroPreview: z.string().max(16).default(DEFAULT_HERO_PREVIEW),
})

/** Register the durable settings section owned by the desktop skin feature. */
export function registerSkinSettings(ctx: Context): void {
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.register(
      settingsNamespace(SKIN_SETTINGS_NAMESPACE),
      SkinSettingsSchema,
    )
  })
}
