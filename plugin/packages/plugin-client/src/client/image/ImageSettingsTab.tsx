import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ImageModelSaveRequest,
  ImageModelSettingsSnapshot,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import css from '../shared/IntegrationSettings.module.css'

export interface ImageSettingsTabInjected {
  snapshot: () => Promise<ImageModelSettingsSnapshot>
  save: (request: ImageModelSaveRequest) => Promise<void>
}

export type ImageSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.image'>
  & InjectFace<ImageSettingsTabInjected>

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: ImageModelSettingsSnapshot }

export function ImageSettingsTab({ snapshot, save, t }: ImageSettingsTabProps): ReactNode {
  const formId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<State>({ status: 'loading' })
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<'saved' | 'saveFailed' | null>(null)

  useEffect(() => {
    let current = true
    void snapshot().then(value => {
      if (!current) return
      setState({ status: 'ready', snapshot: value })
      setProvider(value.image.provider)
      setModel(value.image.model)
    }, () => { if (current) setState({ status: 'error' }) })
    return () => { current = false }
  }, [snapshot, request])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (state.status !== 'ready'
      || saving
      || !dirty
      || provider.length === 0
      || model.length === 0) return
    const nextProvider = provider.trim()
    const nextModel = model.trim()
    setSaving(true)
    setNotice(null)
    try {
      await save({ provider: nextProvider, model: nextModel })
      setProvider(nextProvider)
      setModel(nextModel)
      setState({
        status: 'ready',
        snapshot: { ...state.snapshot, image: { provider: nextProvider, model: nextModel } },
      })
      setNotice('saved')
    } catch {
      setNotice('saveFailed')
    } finally {
      setSaving(false)
    }
  }

  const selectedValue = modelOptionValue(provider, model)
  const selected = state.status === 'ready'
    ? state.snapshot.catalog.flatMap(group => group.models.map(entry => ({ group, entry })))
      .find(candidate => candidate.group.provider === provider && candidate.entry.id === model)
    : undefined
  const dirty = state.status === 'ready'
    && (provider !== state.snapshot.image.provider || model !== state.snapshot.image.model)

  const cancel = (): void => {
    if (state.status !== 'ready') return
    setProvider(state.snapshot.image.provider)
    setModel(state.snapshot.image.model)
    setNotice(null)
  }

  return (
    <section className={css.section} aria-busy={state.status === 'loading' || saving}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button className={css.button} type="button" onClick={() => { setState({ status: 'loading' }); setRequest(value => value + 1) }}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <form className={css.section} onSubmit={event => { void submit(event) }}>
          <div className={css.endpoint}>
            <div className={css.heading}><h3>{t('endpoint')}</h3></div>
            <div className={css.field}>
              <label htmlFor={`${formId}-model`}>{t('model')}</label>
              <select
                id={`${formId}-model`}
                required
                disabled={saving}
                value={selectedValue}
                onChange={event => {
                  const next = parseModelOptionValue(event.currentTarget.value)
                  setProvider(next.provider)
                  setModel(next.model)
                }}
              >
                <option value={modelOptionValue('', '')}>{t('selectModel')}</option>
                {selected === undefined && provider.length > 0 && model.length > 0 ? (
                  <option value={selectedValue}>{t('unavailableSelection')} · {provider} / {model}</option>
                ) : null}
                {state.snapshot.catalog.map(group => (
                  <optgroup key={group.provider} label={`${group.providerName} · ${group.provider}`}>
                    {group.models.map(entry => <option key={entry.id} value={modelOptionValue(group.provider, entry.id)}>{entry.name} · {entry.id}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            {state.snapshot.catalog.length === 0 ? <p className={css.status}>{t('emptyModels')}</p> : null}
            {selected !== undefined ? (
              <div className={css.capabilitySummary} aria-label={t('capabilities')}>
                <span className={css.tag} data-kind="active">{selected.entry.capabilities.adapter === 'openai-images' ? 'OpenAI Images' : 'Gemini Native Image'}</span>
              </div>
            ) : null}
          </div>
          <div className={css.settingsFooter}>
            {notice !== null ? <p className={css.footerNotice} data-kind={notice === 'saved' ? 'ok' : 'error'} role={notice === 'saveFailed' ? 'alert' : undefined}>{t(notice)}</p> : <span className={css.footerNotice} />}
            <div className={css.settingsFooterActions}>
              <button className={css.settingsSecondaryButton} type="button" disabled={saving || !dirty} onClick={cancel}>{t('cancel')}</button>
              <button className={css.settingsPrimaryButton} type="submit" disabled={saving || !dirty || provider.length === 0 || model.length === 0}>{saving ? t('saving') : t('save')}</button>
            </div>
          </div>
        </form>
      ) : null}
    </section>
  )
}

function modelOptionValue(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

function parseModelOptionValue(value: string): { provider: string; model: string } {
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { provider: parsed[0], model: parsed[1] }
    }
  } catch {}
  return { provider: '', model: '' }
}
