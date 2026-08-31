import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ThinkingDataSaveRequest,
  ThinkingDataSnapshot,
  ThinkingDataTestRequest,
  ThinkingDataTestResult,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { ThinkingDataLocaleKey } from '../locales.ts'
import css from './ThinkingDataSettingsSection.module.css'

export interface ThinkingDataSettingsInjected {
  snapshot: () => Promise<ThinkingDataSnapshot>
  save: (request: ThinkingDataSaveRequest) => Promise<void>
  testConnection: (request: ThinkingDataTestRequest) => Promise<ThinkingDataTestResult>
}

export type ThinkingDataSettingsProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.thinkingdata'>
  & InjectFace<ThinkingDataSettingsInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: ThinkingDataSnapshot }

export function ThinkingDataSettingsSection({ snapshot, save, testConnection, t }: ThinkingDataSettingsProps): ReactNode {
  const id = useId()
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [enabled, setEnabled] = useState(false)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const load = (): void => {
    setState({ status: 'loading' })
    void snapshot().then(value => {
      setState({ status: 'ready', snapshot: value })
      setEnabled(value.enabled)
      setUrl(value.url)
      setToken('')
    }, () => { setState({ status: 'error' }) })
  }

  useEffect(load, [snapshot])
  useEffect(() => {
    if (state.status !== 'ready' || !SETTLING_PHASES.has(state.snapshot.phase)) return
    let current = true
    const timer = window.setTimeout(() => {
      void snapshot().then(value => { if (current) setState({ status: 'ready', snapshot: value }) })
    }, 400)
    return () => { current = false; window.clearTimeout(timer) }
  }, [snapshot, state])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setNotice(null)
    try {
      await save({ enabled, url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}) })
      setNotice({ kind: 'success', text: t('saved') })
      const value = await snapshot()
      setState({ status: 'ready', snapshot: value })
      setEnabled(value.enabled)
      setUrl(value.url)
      setToken('')
    } catch {
      setNotice({ kind: 'error', text: t('saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setNotice(null)
    try {
      const result = await testConnection({ url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}) })
      setNotice({ kind: result.ok ? 'success' : 'error', text: t(TEST_KEYS[result.status]) })
    } catch {
      setNotice({ kind: 'error', text: t('unreachable') })
    } finally {
      setTesting(false)
    }
  }

  if (state.status === 'loading') return <p className={css.status}>{t('loading')}</p>
  if (state.status === 'error') {
    return <div className={css.failure}><p role="alert">{t('loadFailed')}</p><button type="button" onClick={load}>{t('retry')}</button></div>
  }

  const dirty = enabled !== state.snapshot.enabled || url.trim() !== state.snapshot.url || token.trim().length > 0
  return (
    <section className={css.section} aria-busy={saving || testing}>
      <header className={css.header}>
        <div><h2>{t('title')}</h2><p>{t('tagline')}</p></div>
        <span className={css.connection} data-phase={state.snapshot.phase}>
          <span aria-hidden="true" />{t(PHASE_KEYS[state.snapshot.phase])}
        </span>
      </header>
      <form className={css.card} onSubmit={event => { void submit(event) }}>
        <label className={css.switchRow}>
          <span><strong>{t('enabled')}</strong><small>{t('enabledHint')}</small></span>
          <input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.currentTarget.checked); setNotice(null) }} />
        </label>
        <div className={css.divider} />
        <div className={css.field}>
          <label htmlFor={`${id}-url`}>{t('url')}</label>
          <input id={`${id}-url`} type="url" value={url} placeholder={state.snapshot.effectiveUrl} onChange={event => { setUrl(event.currentTarget.value); setNotice(null) }} />
          <small>{t('urlHint')}</small>
        </div>
        <div className={css.field}>
          <label htmlFor={`${id}-token`}>{t('token')}</label>
          <input id={`${id}-token`} type="password" autoComplete="new-password" value={token} placeholder={state.snapshot.tokenConfigured ? t('tokenConfigured') : t('tokenPlaceholder')} onChange={event => { setToken(event.currentTarget.value); setNotice(null) }} />
          <small>{state.snapshot.tokenConfigured ? t('tokenRetainHint') : t('tokenHint')}</small>
        </div>
        {notice !== null ? <p className={css.notice} data-kind={notice.kind} role="status">{notice.text}</p> : null}
        <div className={css.actions}>
          <button className={css.secondary} type="button" disabled={saving || testing} onClick={() => { void test() }}>{testing ? t('testing') : t('test')}</button>
          <button className={css.primary} type="submit" disabled={!dirty || saving || testing}>{saving ? t('saving') : t('save')}</button>
        </div>
      </form>
    </section>
  )
}

const PHASE_KEYS = {
  disabled: 'phaseDisabled', 'missing-token': 'phaseMissingToken', pending: 'phaseConnecting', loading: 'phaseConnecting',
  active: 'phaseActive', failed: 'phaseFailed', unloading: 'phaseConnecting',
} satisfies Record<ThinkingDataSnapshot['phase'], ThinkingDataLocaleKey>

const SETTLING_PHASES = new Set<ThinkingDataSnapshot['phase']>(['pending', 'loading', 'unloading'])

const TEST_KEYS = {
  ready: 'ready', connected: 'connected', 'missing-token': 'missingToken', unauthorized: 'unauthorized',
  'not-ready': 'notReady', unreachable: 'unreachable',
} satisfies Record<ThinkingDataTestResult['status'], ThinkingDataLocaleKey>
