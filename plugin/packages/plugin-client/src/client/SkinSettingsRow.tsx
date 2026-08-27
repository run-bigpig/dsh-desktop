import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_SKIN_SETTINGS, SKIN_PRESETS, type SkinBrand, type SkinPreset, type SkinSettings,
} from './skin-controller.ts'
import type { SkinLocaleKey } from './locales.ts'
import css from './SkinSettingsRow.module.css'

export interface SkinSettingsRowInjected {
  scope: SettingsScope<SkinSettings>
  setEnabled: (enabled: boolean) => Promise<void>
  setPreset: (preset: SkinPreset) => Promise<void>
  setBrand: (brand: SkinBrand) => Promise<void>
  setBackgroundImage: (image: string) => Promise<void>
  setTransparency: (transparency: number) => Promise<void>
  clearBackgroundImage: () => Promise<void>
  reset: () => Promise<void>
}

export type SkinSettingsRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.desktopSkin'>
  & SkinSettingsRowInjected

const PREVIEW_COLORS: Readonly<Record<SkinPreset, readonly [string, string, string]>> = {
  ink: ['#10151c', '#263b59', '#a9c7ee'],
  forest: ['#111a15', '#2d664b', '#91c9a8'],
  sand: ['#1d1712', '#985f32', '#e3b37f'],
}

export const MAX_SKIN_BACKGROUND_IMAGE_BYTES = 5 * 1024 * 1024
const SUPPORTED_SKIN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])

export class SkinImageError extends Error {
  constructor(readonly code: 'type' | 'size' | 'read') {
    super(`skin image ${code} error`)
  }
}

/** Validate and encode one local background image for durable settings storage. */
export function readSkinImage(file: File): Promise<string> {
  if (!SUPPORTED_SKIN_IMAGE_TYPES.has(file.type)) return Promise.reject(new SkinImageError('type'))
  if (file.size > MAX_SKIN_BACKGROUND_IMAGE_BYTES) return Promise.reject(new SkinImageError('size'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(new SkinImageError('read')) }
    reader.onload = () => {
      const value = reader.result
      if (typeof value !== 'string' || !value.startsWith('data:image/')) {
        reject(new SkinImageError('read'))
        return
      }
      resolve(value)
    }
    reader.readAsDataURL(file)
  })
}

/** General-settings row for the desktop-owned token skin and brand Slots. */
export function SkinSettingsRow({
  scope,
  setEnabled,
  setPreset,
  setBrand,
  setBackgroundImage,
  setTransparency,
  clearBackgroundImage,
  reset,
  t,
}: SkinSettingsRowProps) {
  const snapshot = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
  const settings = snapshot.value ?? DEFAULT_SKIN_SETTINGS
  const unavailable = snapshot.status !== 'ready' || !snapshot.writable
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [imageError, setImageError] = useState<SkinImageError['code'] | undefined>()
  const [transparency, setTransparencyDraft] = useState(settings.transparency)
  useEffect(() => { setTransparencyDraft(settings.transparency) }, [settings.transparency])
  const resetDisabled = unavailable
    || (settings.enabled === DEFAULT_SKIN_SETTINGS.enabled
      && settings.preset === DEFAULT_SKIN_SETTINGS.preset
      && settings.brand === DEFAULT_SKIN_SETTINGS.brand
      && settings.backgroundImage === DEFAULT_SKIN_SETTINGS.backgroundImage
      && settings.transparency === DEFAULT_SKIN_SETTINGS.transparency)

  const chooseImage = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setImageError(undefined)
    try {
      await setBackgroundImage(await readSkinImage(file))
    } catch (error) {
      setImageError(error instanceof SkinImageError ? error.code : 'read')
    } finally {
      if (fileInput.current !== null) fileInput.current.value = ''
    }
  }

  const persistTransparency = (): void => {
    if (transparency !== settings.transparency) void setTransparency(transparency)
  }

  return (
    <section className={css.group} aria-labelledby="desktop-skin-title">
      <div className={css.heading}>
        <div className={css.headingText}>
          <div id="desktop-skin-title" className={css.title}>{t('title')}</div>
          <div className={css.description}>{t('description')}</div>
        </div>
        <label className={css.switchLabel}>
          <span>{t('enabled')}</span>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={unavailable}
            onChange={event => { void setEnabled(event.currentTarget.checked) }}
          />
        </label>
      </div>

      <fieldset className={css.fieldset} disabled={unavailable || !settings.enabled}>
        <legend>{t('preset')}</legend>
        <div className={css.presetGrid}>
          {SKIN_PRESETS.map(preset => {
            const colors = PREVIEW_COLORS[preset]
            const style = {
              '--skin-preview-base': colors[0],
              '--skin-preview-accent': colors[1],
              '--skin-preview-highlight': colors[2],
            } as CSSProperties
            return (
              <button
                key={preset}
                type="button"
                className={css.presetCard}
                aria-pressed={settings.preset === preset}
                onClick={() => { void setPreset(preset) }}
              >
                <span className={css.preview} style={style} aria-hidden="true">
                  <span className={css.previewRail} />
                  <span className={css.previewLine} />
                  <span className={css.previewAccent} />
                </span>
                <span>{t(`preset.${preset}` as SkinLocaleKey)}</span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <fieldset className={css.fieldset} disabled={unavailable || !settings.enabled}>
        <legend>{t('background')}</legend>
        <div className={css.backgroundEditor}>
          <button
            type="button"
            className={css.imagePreview}
            style={settings.backgroundImage === ''
              ? undefined
              : { backgroundImage: `url(${JSON.stringify(settings.backgroundImage)})` }}
            onClick={() => { fileInput.current?.click() }}
            aria-label={settings.backgroundImage === '' ? t('background.choose') : t('background.replace')}
          >
            {settings.backgroundImage === '' && <span>{t('background.empty')}</span>}
          </button>
          <div className={css.backgroundControls}>
            <div className={css.imageActions}>
              <button type="button" className={css.brandButton} onClick={() => { fileInput.current?.click() }}>
                {settings.backgroundImage === '' ? t('background.choose') : t('background.replace')}
              </button>
              <button
                type="button"
                className={css.brandButton}
                disabled={settings.backgroundImage === ''}
                onClick={() => { setImageError(undefined); void clearBackgroundImage() }}
              >
                {t('background.clear')}
              </button>
            </div>
            <input
              ref={fileInput}
              className={css.fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              onChange={event => { void chooseImage(event.currentTarget.files?.[0]) }}
            />
            <div className={css.imageHint}>{t('background.hint')}</div>
            {imageError !== undefined && (
              <div className={css.imageError} role="alert">
                {t(`background.error.${imageError}` as SkinLocaleKey)}
              </div>
            )}
          </div>
        </div>
        <label className={css.transparencyLabel}>
          <span>{t('transparency')}</span>
          <input
            type="range"
            min="0"
            max="80"
            step="1"
            aria-label={t('transparency')}
            value={transparency}
            onChange={event => { setTransparencyDraft(Number(event.currentTarget.value)) }}
            onPointerUp={persistTransparency}
            onKeyUp={persistTransparency}
            onBlur={persistTransparency}
          />
          <output>{transparency}%</output>
        </label>
        <div className={css.imageHint}>{t('transparency.hint')}</div>
      </fieldset>

      <fieldset className={css.fieldset} disabled={unavailable}>
        <legend>{t('brand')}</legend>
        <div className={css.brandOptions}>
          {(['deepseek', 'desktop'] as const).map(brand => (
            <button
              key={brand}
              type="button"
              className={css.brandButton}
              aria-pressed={settings.brand === brand}
              onClick={() => { void setBrand(brand) }}
            >
              {t(`brand.${brand}` as SkinLocaleKey)}
            </button>
          ))}
        </div>
      </fieldset>

      <div className={css.footer}>
        <span>{snapshot.status === 'loading' ? t('loading') : t('scope')}</span>
        <button type="button" className={css.reset} disabled={resetDisabled} onClick={() => { void reset() }}>
          {t('reset')}
        </button>
      </div>
    </section>
  )
}
