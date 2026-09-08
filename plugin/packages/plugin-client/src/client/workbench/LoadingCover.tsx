import css from './LoadingCover.module.css'

/** Keep the content's geometry while its first usable view is being prepared. */
export function LoadingCover({ loading, label }: { loading: boolean; label: string }) {
  return <div className={css.cover} data-loading={loading || undefined} aria-hidden={!loading}>
    <span className={css.hint} role={loading ? 'status' : undefined}>{label}</span>
  </div>
}
