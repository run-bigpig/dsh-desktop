import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const SKIN_SETTINGS_NAMESPACE = 'desktop-skin'
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

const MAX_BACKGROUND_IMAGE_DATA_URL_CHARS = 7_000_000
const BACKGROUND_IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,/

export const SkinSettingsSchema: z<SkinSettings> = z.object({
  enabled: z.boolean().default(false),
  preset: z.union([...SKIN_PRESETS]).default('ink'),
  brand: z.union([...SKIN_BRANDS]).default('deepseek'),
  backgroundImage: z.union([
    '',
    z.string().max(MAX_BACKGROUND_IMAGE_DATA_URL_CHARS).pattern(BACKGROUND_IMAGE_DATA_URL_PATTERN),
  ]).default(''),
  transparency: z.number().step(1).min(0).max(80).default(20),
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
