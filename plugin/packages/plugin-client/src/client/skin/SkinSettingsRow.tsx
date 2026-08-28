import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_BRAND_TITLE,
  DEFAULT_HERO_HEADLINE,
  DEFAULT_HERO_PREVIEW,
  DEFAULT_SKIN_SETTINGS,
  SKIN_PRESETS,
  type SkinPreset,
  type SkinSettings,
} from './skin-controller.ts'
import { DEFAULT_BRAND_LOGO } from './default-brand-logo.ts'
import type { SkinLocaleKey } from '../locales.ts'
import css from './SkinSettingsRow.module.css'

export interface SkinSettingsRowInjected {
  scope: SettingsScope<SkinSettings>
  setEnabled: (enabled: boolean) => Promise<void>
  setPreset: (preset: SkinPreset) => Promise<void>
  setBackgroundImage: (image: string) => Promise<void>
  setTransparency: (transparency: number) => Promise<void>
  clearBackgroundImage: () => Promise<void>
  setLogoImage: (image: string) => Promise<void>
  clearLogoImage: () => Promise<void>
  setBrandTitle: (title: string) => Promise<void>
  setHeroHeadline: (headline: string) => Promise<void>
  setHeroPreview: (preview: string) => Promise<void>
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
export const MAX_SKIN_LOGO_IMAGE_BYTES = 1024 * 1024
const SUPPORTED_SKIN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
const SUPPORTED_SKIN_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif'])

export class SkinImageError extends Error {
  constructor(readonly code: 'type' | 'size' | 'read') {
    super(`skin image ${code} error`)
  }
}

/** Validate and encode one local background image for durable settings storage. */
export function readSkinImage(file: File): Promise<string> {
  return readImage(file, SUPPORTED_SKIN_IMAGE_TYPES, MAX_SKIN_BACKGROUND_IMAGE_BYTES)
}

/** Validate and encode one non-animated logo for durable settings storage. */
export function readSkinLogo(file: File): Promise<string> {
  return readImage(file, SUPPORTED_SKIN_LOGO_TYPES, MAX_SKIN_LOGO_IMAGE_BYTES)
}

function readImage(file: File, supportedTypes: ReadonlySet<string>, maxBytes: number): Promise<string> {
  if (!supportedTypes.has(file.type)) return Promise.reject(new SkinImageError('type'))
  if (file.size > maxBytes) return Promise.reject(new SkinImageError('size'))
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
  setBackgroundImage,
  setTransparency,
  clearBackgroundImage,
  setLogoImage,
  clearLogoImage,
  setBrandTitle,
  setHeroHeadline,
  setHeroPreview,
  reset,
  t,
}: SkinSettingsRowProps) {
  const snapshot = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
  const settings = { ...DEFAULT_SKIN_SETTINGS, ...snapshot.value }
  const unavailable = snapshot.status !== 'ready' || !snapshot.writable
  const fileInput = useRef<HTMLInputElement | null>(null)
  const logoInput = useRef<HTMLInputElement | null>(null)
  const [imageError, setImageError] = useState<SkinImageError['code'] | undefined>()
  const [logoError, setLogoError] = useState<SkinImageError['code'] | undefined>()
  const [transparency, setTransparencyDraft] = useState(settings.transparency)
  const [brandTitle, setBrandTitleDraft] = useState(settings.brandTitle)
  const [heroHeadline, setHeroHeadlineDraft] = useState(settings.heroHeadline)
  const [heroPreview, setHeroPreviewDraft] = useState(settings.heroPreview)
  const editingBrandTitle = useRef(false)
  const editingHeroHeadline = useRef(false)
  const editingHeroPreview = useRef(false)
  useEffect(() => { setTransparencyDraft(settings.transparency) }, [settings.transparency])
  useEffect(() => {
    if (!editingBrandTitle.current) setBrandTitleDraft(settings.brandTitle)
  }, [settings.brandTitle])
  useEffect(() => {
    if (!editingHeroHeadline.current) setHeroHeadlineDraft(settings.heroHeadline)
  }, [settings.heroHeadline])
  useEffect(() => {
    if (!editingHeroPreview.current) setHeroPreviewDraft(settings.heroPreview)
  }, [settings.heroPreview])
  const resetDisabled = unavailable
    || (settings.enabled === DEFAULT_SKIN_SETTINGS.enabled
      && settings.preset === DEFAULT_SKIN_SETTINGS.preset
      && settings.backgroundImage === DEFAULT_SKIN_SETTINGS.backgroundImage
      && settings.transparency === DEFAULT_SKIN_SETTINGS.transparency
      && settings.logoImage === DEFAULT_SKIN_SETTINGS.logoImage
      && settings.brandTitle === DEFAULT_SKIN_SETTINGS.brandTitle
      && settings.heroHeadline === DEFAULT_SKIN_SETTINGS.heroHeadline
      && settings.heroPreview === DEFAULT_SKIN_SETTINGS.heroPreview)

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

  const chooseLogo = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setLogoError(undefined)
    try {
      await setLogoImage(await readSkinLogo(file))
    } catch (error) {
      setLogoError(error instanceof SkinImageError ? error.code : 'read')
    } finally {
      if (logoInput.current !== null) logoInput.current.value = ''
    }
  }

  const persistTransparency = (): void => {
    if (transparency !== settings.transparency) void setTransparency(transparency)
  }

  const persistBrandTitle = (): void => {
    editingBrandTitle.current = false
    if (brandTitle !== settings.brandTitle) void setBrandTitle(brandTitle)
  }

  const persistHeroHeadline = (): void => {
    editingHeroHeadline.current = false
    if (heroHeadline !== settings.heroHeadline) void setHeroHeadline(heroHeadline)
  }

  const persistHeroPreview = (): void => {
    editingHeroPreview.current = false
    if (heroPreview !== settings.heroPreview) void setHeroPreview(heroPreview)
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
        <div className={css.brandEditor}>
          <div className={css.logoEditor}>
            <button
              type="button"
              className={css.logoPreview}
              onClick={() => { logoInput.current?.click() }}
              aria-label={settings.logoImage === '' ? t('logo.choose') : t('logo.replace')}
            >
              <img src={settings.logoImage || DEFAULT_BRAND_LOGO} alt="" />
            </button>
            <div className={css.backgroundControls}>
              <div className={css.imageActions}>
                <button type="button" className={css.brandButton} onClick={() => { logoInput.current?.click() }}>
                  {settings.logoImage === '' ? t('logo.choose') : t('logo.replace')}
                </button>
                <button
                  type="button"
                  className={css.brandButton}
                  disabled={settings.logoImage === ''}
                  onClick={() => { setLogoError(undefined); void clearLogoImage() }}
                >
                  {t('logo.clear')}
                </button>
              </div>
              <input
                ref={logoInput}
                className={css.fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/avif"
                onChange={event => { void chooseLogo(event.currentTarget.files?.[0]) }}
              />
              <div className={css.imageHint}>{t('logo.hint')}</div>
              {logoError !== undefined && (
                <div className={css.imageError} role="alert">
                  {t(`logo.error.${logoError}` as SkinLocaleKey)}
                </div>
              )}
            </div>
          </div>
          <label className={css.textField}>
            <span>{t('brand.title')}</span>
            <input
              type="text"
              aria-label={t('brand.title')}
              maxLength={32}
              value={brandTitle}
              placeholder={DEFAULT_BRAND_TITLE}
              onFocus={() => { editingBrandTitle.current = true }}
              onChange={event => { setBrandTitleDraft(event.currentTarget.value) }}
              onBlur={persistBrandTitle}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
            />
            <small>{t('brand.title.hint')}</small>
          </label>
          <div className={css.copyGrid}>
            <label className={css.textField}>
              <span>{t('hero.headline')}</span>
              <input
                type="text"
                aria-label={t('hero.headline')}
                maxLength={48}
                value={heroHeadline}
                placeholder={DEFAULT_HERO_HEADLINE}
                onFocus={() => { editingHeroHeadline.current = true }}
                onChange={event => { setHeroHeadlineDraft(event.currentTarget.value) }}
                onBlur={persistHeroHeadline}
                onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
              />
            </label>
            <label className={css.textField}>
              <span>{t('hero.preview')}</span>
              <input
                type="text"
                aria-label={t('hero.preview')}
                maxLength={16}
                value={heroPreview}
                placeholder={DEFAULT_HERO_PREVIEW}
                onFocus={() => { editingHeroPreview.current = true }}
                onChange={event => { setHeroPreviewDraft(event.currentTarget.value) }}
                onBlur={persistHeroPreview}
                onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
              />
            </label>
          </div>
          <div className={css.imageHint}>{t('hero.hint')}</div>
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
