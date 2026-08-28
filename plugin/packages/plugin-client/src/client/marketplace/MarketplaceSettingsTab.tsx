import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MarketplaceMutationRequest,
  MarketplaceOperation,
  MarketplacePlugin,
  MarketplaceSnapshot,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import css from './MarketplaceSettingsTab.module.css'

export interface MarketplaceSettingsTabInjected {
  catalog: () => Promise<MarketplaceSnapshot>
  mutate: (request: MarketplaceMutationRequest) => Promise<MarketplaceOperation>
  activeOperation: () => Promise<MarketplaceOperation | null>
  operation: (id: string) => Promise<MarketplaceOperation>
}

export type MarketplaceSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.marketplace'>
  & InjectFace<MarketplaceSettingsTabInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: MarketplaceSnapshot }

const TERMINAL_PHASES = new Set<MarketplaceOperation['phase']>(['completed', 'failed', 'rolled-back'])

function matches(plugin: MarketplacePlugin, query: string): boolean {
  if (query.length === 0) return true
  return [plugin.name, plugin.description, plugin.publisher, plugin.packageName, ...plugin.permissions]
    .some(value => value.toLocaleLowerCase().includes(query))
}

function actionFor(plugin: MarketplacePlugin): MarketplaceMutationRequest['action'] {
  if (plugin.installedVersion === null) return 'install'
  return plugin.updateAvailable ? 'update' : 'uninstall'
}

export function MarketplaceSettingsTab({
  catalog,
  mutate,
  activeOperation,
  operation,
  t,
}: MarketplaceSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ViewState>({ status: 'loading' })
  const [active, setActive] = useState<MarketplaceOperation | null>(null)

  useEffect(() => {
    let current = true
    void activeOperation().then(
      next => { if (current && next !== null) setActive(next) },
      error => { console.error('[desktop-marketplace] restoring the active plugin operation failed:', error) },
    )
    return () => { current = false }
  }, [activeOperation])

  useEffect(() => {
    let current = true
    void catalog().then(
      snapshot => { if (current) setView({ status: 'ready', snapshot }) },
      error => {
        console.error('[desktop-marketplace] reading the plugin catalog failed:', error)
        if (current) setView({ status: 'error' })
      },
    )
    return () => { current = false }
  }, [catalog, request])

  useEffect(() => {
    if (active === null || TERMINAL_PHASES.has(active.phase)) return
    let current = true
    const timer = window.setTimeout(() => {
      void operation(active.id).then(
        next => {
          if (!current) return
          setActive(next)
          if (TERMINAL_PHASES.has(next.phase)) setRequest(value => value + 1)
        },
        error => {
          console.error('[desktop-marketplace] reading the plugin operation failed:', error)
          if (!current) return
          // Installing or removing a persistent profile plugin restarts Harness.
          // The Remote connection disappears during that handoff even though the
          // desktop-side operation is still running, so retry instead of turning
          // the expected disconnect into a false terminal failure.
          setActive(previous => previous?.id === active.id ? { ...previous } : previous)
        },
      )
    }, 650)
    return () => { current = false; window.clearTimeout(timer) }
  }, [active, operation, t])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const plugins = useMemo(
    () => view.status === 'ready'
      ? view.snapshot.plugins.filter(plugin => matches(plugin, normalizedQuery))
      : [],
    [normalizedQuery, view],
  )

  const retry = (): void => {
    setView({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const begin = (plugin: MarketplacePlugin, action: MarketplaceMutationRequest['action']): void => {
    void mutate({ pluginId: plugin.id, action }).then(setActive, error => {
      console.error('[desktop-marketplace] starting the plugin operation failed:', error)
      setActive({
        id: 'failed',
        pluginId: plugin.id,
        action,
        phase: 'failed',
        progress: 0,
        message: t('operationFailed'),
        error: t('operationFailed'),
      })
    })
  }

  return (
    <section className={css.section} aria-busy={view.status === 'loading'}>
      {view.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {view.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('loadError')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}

      {view.status === 'ready' ? (
        <div className={css.catalog}>
          <div className={css.toolbar}>
            <label className={css.search}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5.25" />
                <path d="m12.4 12.4 4 4" />
              </svg>
              <span className={css.visuallyHidden}>{t('search')}</span>
              <input
                type="search"
                value={query}
                placeholder={t('search')}
                aria-label={t('search')}
                onChange={event => { setQuery(event.currentTarget.value) }}
              />
            </label>
            <span className={css.trust} data-verified={view.snapshot.catalogVerified ? 'true' : 'false'}>
              <span aria-hidden="true" />
              {t(view.snapshot.catalogVerified ? 'catalogVerified' : 'catalogUnverified')}
            </span>
          </div>

          {view.snapshot.warning !== null ? <p className={css.catalogWarning}>{view.snapshot.warning}</p> : null}
          {view.snapshot.plugins.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {view.snapshot.plugins.length > 0 && plugins.length === 0
            ? <p className={css.status}>{t('emptySearch')}</p>
            : null}

          <ul className={css.cards}>
            {plugins.map(plugin => {
              const pluginOperation = active?.pluginId === plugin.id ? active : null
              const pending = pluginOperation !== null && !TERMINAL_PHASES.has(pluginOperation.phase)
              const action = actionFor(plugin)
              const actionLabel = action === 'install' ? t('install') : action === 'update' ? t('update') : t('uninstall')
              const operationRunning = active !== null && !TERMINAL_PHASES.has(active.phase)
              return (
                <li className={css.card} key={plugin.id}>
                  <div className={css.identity}>
                    <strong>{plugin.name}</strong>
                    <span>{plugin.publisher} · {plugin.version}</span>
                  </div>
                  <p className={css.description}>{plugin.description}</p>
                  <div className={css.meta}>
                    <span>{plugin.license}</span>
                    <span>{plugin.permissions.length === 0 ? t('noPermissions') : `${t('permissions')}: ${plugin.permissions.join(', ')}`}</span>
                  </div>
                  {pluginOperation !== null ? (
                    <div className={css.operation} data-failed={pluginOperation.phase === 'failed' ? 'true' : 'false'}>
                      <div><span>{pluginOperation.message}</span><span>{pluginOperation.progress}%</span></div>
                      <progress max="100" value={pluginOperation.progress} />
                      {pluginOperation.error !== null ? <p role="alert">{pluginOperation.error}</p> : null}
                    </div>
                  ) : null}
                  <div className={css.actions}>
                    {plugin.installedVersion !== null ? <span>{t('installed')} {plugin.installedVersion}</span> : <span />}
                    <div className={css.actionButtons}>
                      {action === 'update' ? (
                        <button
                          type="button"
                          data-action="uninstall"
                          disabled={operationRunning}
                          onClick={() => { begin(plugin, 'uninstall') }}
                        >
                          {t('uninstall')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        data-action={action}
                        disabled={pending || operationRunning}
                        onClick={() => { begin(plugin, action) }}
                      >
                        {pending ? `${pluginOperation?.progress ?? 0}%` : actionLabel}
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
