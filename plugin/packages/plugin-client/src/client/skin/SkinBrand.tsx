import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandNameOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { DEFAULT_BRAND_LOGO } from './default-brand-logo.ts'
import {
  DEFAULT_BRAND_TITLE,
  DEFAULT_HERO_HEADLINE,
  DEFAULT_HERO_PREVIEW,
  DEFAULT_SKIN_SETTINGS,
  type SkinSettings,
} from './skin-controller.ts'
import css from './SkinBrand.module.css'

export { DEFAULT_BRAND_TITLE } from './skin-controller.ts'

interface SkinBrandInjected {
  scope: SettingsScope<SkinSettings>
}

export type SkinBrandMarkProps = SkinBrandInjected & {
  size: HeroBrandMarkOwnerProps['size']
  className?: HeroBrandMarkOwnerProps['className']
  placement: 'hero' | 'sidebar'
}

export type SkinBrandNameProps = SidebarBrandNameOwnerProps & SkinBrandInjected

function useSkinSettings(scope: SettingsScope<SkinSettings>): SkinSettings {
  const snapshot = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
  return { ...DEFAULT_SKIN_SETTINGS, ...snapshot.value }
}

/** Replace only the two text siblings owned by the pinned Hero headline. */
function useHeroCopy(
  mark: RefObject<HTMLSpanElement>,
  placement: SkinBrandMarkProps['placement'],
  headline: string,
  preview: string,
): void {
  useLayoutEffect(() => {
    if (placement !== 'hero') return
    let anchor: Element | null | undefined = mark.current
    let headlineNode: Element | null | undefined
    let previewNode: Element | null | undefined
    for (let depth = 0; depth < 6 && anchor !== null && anchor !== undefined; depth++) {
      const candidateHeadline = anchor.nextElementSibling
      const candidatePreview = candidateHeadline?.nextElementSibling
      if (candidateHeadline !== null && candidateHeadline !== undefined
        && candidatePreview !== null && candidatePreview !== undefined
        && candidateHeadline.parentElement === anchor.parentElement
        && candidatePreview.parentElement === anchor.parentElement) {
        headlineNode = candidateHeadline
        previewNode = candidatePreview
        break
      }
      anchor = anchor.parentElement
    }
    if (headlineNode === null || headlineNode === undefined
      || previewNode === null || previewNode === undefined) return

    let originalHeadline = headlineNode.textContent ?? ''
    let originalPreview = previewNode.textContent ?? ''
    if (headline !== '') headlineNode.textContent = headline
    if (preview !== '') previewNode.textContent = preview
    const observer = new MutationObserver(() => {
      if (headline !== '' && headlineNode.textContent !== headline) {
        originalHeadline = headlineNode.textContent ?? ''
        headlineNode.textContent = headline
      }
      if (preview !== '' && previewNode.textContent !== preview) {
        originalPreview = previewNode.textContent ?? ''
        previewNode.textContent = preview
      }
    })
    observer.observe(headlineNode, { childList: true, characterData: true, subtree: true })
    observer.observe(previewNode, { childList: true, characterData: true, subtree: true })
    return () => {
      observer.disconnect()
      if (headline !== '' && headlineNode.textContent === headline) headlineNode.textContent = originalHeadline
      if (preview !== '' && previewNode.textContent === preview) previewNode.textContent = originalPreview
    }
  }, [headline, placement, preview])
}

/** Built-in mark used while the custom brand setting owns the supported brand Slots. */
export function SkinBrandMark({ size, className, placement, scope }: SkinBrandMarkProps) {
  const settings = useSkinSettings(scope)
  const mark = useRef<HTMLSpanElement>(null)
  useHeroCopy(
    mark,
    placement,
    settings.heroHeadline || DEFAULT_HERO_HEADLINE,
    settings.heroPreview || DEFAULT_HERO_PREVIEW,
  )
  return (
    <span ref={mark} className={css.anchor}>
      <img
        aria-hidden="true"
        className={`${className ?? ''} ${css.mark}`.trim()}
        width={size}
        height={size}
        src={settings.logoImage || DEFAULT_BRAND_LOGO}
        alt=""
        data-avilo-brand-mark={placement}
      />
    </span>
  )
}

/** Compact wordmark for the expanded sidebar brand-name Slot. */
export function SkinBrandName({ scope }: SkinBrandNameProps) {
  const settings = useSkinSettings(scope)
  return <span className={css.name}>{settings.brandTitle || DEFAULT_BRAND_TITLE}</span>
}
