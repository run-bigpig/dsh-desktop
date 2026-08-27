import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './SkinBrand.module.css'

type SkinBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/** DSH-DeskTop mark used only while the custom brand setting owns the brand Slots. */
export function SkinBrandMark({ size, className }: SkinBrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
    >
      <rect x="2" y="2" width="28" height="28" rx="9" fill="var(--dsw-alias-brand-primary)" />
      <path className={css.window} d="M9 10.5h14v10.75H9zM9 14h14M16 21.25v3.25M12.5 24.5h7" />
      <circle className={css.dot} cx="11.2" cy="12.25" r="0.75" />
      <circle className={css.dot} cx="13.6" cy="12.25" r="0.75" />
    </svg>
  )
}

/** Compact wordmark for the expanded sidebar brand-name Slot. */
export function SkinBrandName() {
  return <span className={css.name}>DSH-DeskTop</span>
}
