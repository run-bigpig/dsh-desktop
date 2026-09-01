import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OpenPencilPhase, OpenPencilSnapshot } from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { OpenPencilLocaleKey } from '../locales.ts'
import css from '../shared/IntegrationSettings.module.css'

export interface OpenPencilSettingsTabInjected {
  snapshot: () => Promise<OpenPencilSnapshot>
  launch: () => Promise<OpenPencilSnapshot>
  connect: () => Promise<OpenPencilSnapshot>
  disconnect: () => Promise<OpenPencilSnapshot>
}

export type OpenPencilSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.openpencil'>
  & InjectFace<OpenPencilSettingsTabInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: OpenPencilSnapshot }

const PHASE_KEYS = {
  disabled: 'phaseDisabled',
  'app-stopped': 'phaseAppStopped',
  connecting: 'phaseConnecting',
  active: 'phaseActive',
  failed: 'phaseFailed',
} satisfies Record<OpenPencilPhase, OpenPencilLocaleKey>

export function OpenPencilSettingsTab({ snapshot, launch, connect, disconnect, t }: OpenPencilSettingsTabProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' })
    try {
      setState({ status: 'ready', snapshot: await snapshot() })
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : t('operationFailed') })
    }
  }, [snapshot, t])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (state.status !== 'ready' || !['connecting', 'app-stopped'].includes(state.snapshot.phase)) return
    let current = true
    const timer = window.setTimeout(() => {
      void snapshot().then(value => {
        if (current) setState({ status: 'ready', snapshot: value })
      }, error => {
        if (current) setState({ status: 'error', message: error instanceof Error ? error.message : t('operationFailed') })
      })
    }, state.snapshot.phase === 'connecting' ? 400 : 1_000)
    return () => { current = false; window.clearTimeout(timer) }
  }, [snapshot, state, t])

  const mutate = async (action: () => Promise<OpenPencilSnapshot>): Promise<void> => {
    setBusy(true)
    try {
      setState({ status: 'ready', snapshot: await action() })
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : t('operationFailed') })
    } finally {
      setBusy(false)
    }
  }

  const phaseLabel = state.status === 'ready' ? t(PHASE_KEYS[state.snapshot.phase]) : ''

  return (
    <section className={css.section} aria-busy={busy || state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{state.message}</p>
          <button className={css.button} type="button" onClick={() => { void refresh() }}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className={css.form}>
          <div className={css.heading}><h3>{t('title')}</h3></div>
          <p className={css.hint}>{t('description')}</p>
          <div className={css.capabilitySummary}>
            <span className={css.tag} data-kind={state.snapshot.bundled ? 'active' : undefined}>
              {state.snapshot.bundled ? t('bundled') : t('missing')}
            </span>
            <span className={css.tag} data-kind={state.snapshot.running ? 'active' : undefined}>
              {state.snapshot.running ? t('running') : t('stopped')}
            </span>
            <span className={css.tag} data-kind={state.snapshot.phase === 'active' ? 'active' : state.snapshot.phase === 'failed' ? 'failed' : undefined}>
              {phaseLabel}
            </span>
          </div>
          {state.snapshot.running ? (
            <p className={css.notice}>
              {t('endpoint')} 127.0.0.1:{state.snapshot.port ?? '—'} · {state.snapshot.toolCount} {t('tools')}
            </p>
          ) : null}
          <div className={css.actions}>
            <button className={css.button} type="button" disabled={busy} onClick={() => { void refresh() }}>{t('refresh')}</button>
            <div className={css.buttonGroup}>
              {!state.snapshot.running ? (
                <button className={css.primaryButton} type="button" disabled={busy || !state.snapshot.bundled} onClick={() => { void mutate(launch) }}>
                  {t('launch')}
                </button>
              ) : null}
              {state.snapshot.running && (!state.snapshot.enabled || state.snapshot.phase === 'failed') ? (
                <button className={css.primaryButton} type="button" disabled={busy} onClick={() => { void mutate(connect) }}>
                  {t('connect')}
                </button>
              ) : null}
              {state.snapshot.enabled ? (
                <button className={css.dangerButton} type="button" disabled={busy} onClick={() => { void mutate(disconnect) }}>
                  {t('disconnect')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
