import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  VisionBridgeSnapshot,
  VisionSaveRequest,
  VisionTestRequest,
  VisionTestResult,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import css from './IntegrationSettings.module.css'

export interface VisionSettingsTabInjected {
  snapshot: () => Promise<VisionBridgeSnapshot>
  save: (request: VisionSaveRequest) => Promise<void>
  testConnection: (request: VisionTestRequest) => Promise<VisionTestResult>
}

export type VisionSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.vision'>
  & InjectFace<VisionSettingsTabInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: VisionBridgeSnapshot }

export function VisionSettingsTab({ snapshot, save, testConnection, t }: VisionSettingsTabProps): ReactNode {
  const formId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<VisionTestResult | null>(null)

  useEffect(() => {
    let current = true
    void snapshot().then(value => {
      if (!current) return
      setState({ status: 'ready', snapshot: value })
      setProvider(value.vision.provider)
      setModel(value.vision.model)
      setEnabled(Object.fromEntries(value.targets.map(target => [targetKey(target.provider, target.model), target.enabled])))
    }, () => { if (current) setState({ status: 'error' }) })
    return () => { current = false }
  }, [snapshot, request])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (state.status !== 'ready' || saving || !dirty || provider.length === 0 || model.length === 0) return
    const nextProvider = provider.trim()
    const nextModel = model.trim()
    setSaving(true)
    setNotice(null)
    try {
      const targets = state.snapshot.catalog.flatMap(group => group.models.map(entry => ({
        provider: group.provider,
        model: entry.id,
        enabled: !entry.nativeVision && enabled[targetKey(group.provider, entry.id)] === true,
      })))
      await save({
        vision: {
          provider: nextProvider,
          model: nextModel,
        },
        targets,
      })
      setProvider(nextProvider)
      setModel(nextModel)
      setState({
        status: 'ready',
        snapshot: {
          ...state.snapshot,
          vision: { provider: nextProvider, model: nextModel },
          targets,
        },
      })
      setNotice({ kind: 'ok', message: t('saved') })
    } catch {
      setNotice({ kind: 'error', message: t('saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setNotice(null)
    try {
      setNotice(await testConnection({
        provider: provider.trim(),
        model: model.trim(),
      }))
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('saveFailed') })
    } finally {
      setTesting(false)
    }
  }

  const selectedKey = modelOptionValue(provider, model)
  const selectedAvailable = state.status === 'ready' && state.snapshot.catalog.some(group =>
    group.provider === provider && group.models.some(entry => entry.id === model))
  const visionModelCount = state.status === 'ready'
    ? state.snapshot.catalog.reduce((count, group) => count + group.models.length, 0)
    : 0
  const dirty = state.status === 'ready' && (
    provider !== state.snapshot.vision.provider
    || model !== state.snapshot.vision.model
    || state.snapshot.catalog.some(group => group.models.some(entry => {
      if (entry.nativeVision) return false
      const key = targetKey(group.provider, entry.id)
      const saved = state.snapshot.targets.some(target => target.provider === group.provider && target.model === entry.id && target.enabled)
      return (enabled[key] === true) !== saved
    }))
  )

  const cancel = (): void => {
    if (state.status !== 'ready') return
    setProvider(state.snapshot.vision.provider)
    setModel(state.snapshot.vision.model)
    setEnabled(Object.fromEntries(state.snapshot.targets.map(target => [targetKey(target.provider, target.model), target.enabled])))
    setNotice(null)
  }

  return (
    <section className={css.section} aria-busy={state.status === 'loading' || saving || testing}>
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
                disabled={saving || testing}
                value={selectedKey}
                onChange={event => {
                  const selection = parseModelOptionValue(event.currentTarget.value)
                  setProvider(selection.provider)
                  setModel(selection.model)
                }}
              >
                <option value={modelOptionValue('', '')}>{t('selectModel')}</option>
                {!selectedAvailable && provider.length > 0 && model.length > 0 ? (
                  <option value={selectedKey}>{t('unavailableSelection')} · {provider} / {model}</option>
                ) : null}
                {state.snapshot.catalog.map(group => {
                  const models = group.models
                  return models.length === 0 ? null : (
                    <optgroup key={group.provider} label={`${group.providerName} · ${group.provider}`}>
                      {models.map(entry => <option key={entry.id} value={modelOptionValue(group.provider, entry.id)}>{entry.name} · {entry.id}</option>)}
                    </optgroup>
                  )
                })}
              </select>
            </div>
            {visionModelCount === 0 ? <p className={css.status}>{t('emptyVisionModels')}</p> : null}
          </div>

          <div className={css.toolbar}>
            <div className={css.heading}><h3>{t('targets')}</h3></div>
          </div>
          {state.snapshot.catalog.length === 0 ? <p className={css.status}>{t('emptyCatalog')}</p> : null}
          <ul className={css.groups}>
            {state.snapshot.catalog.map(group => {
              const wrapped = group.models.filter(entry => !entry.nativeVision && enabled[targetKey(group.provider, entry.id)] === true).length
              const open = expanded[group.provider] ?? wrapped > 0
              return (
                <li className={css.card} key={group.provider}>
                  <button className={css.providerButton} type="button" aria-expanded={open} onClick={() => { setExpanded(current => ({ ...current, [group.provider]: !open })) }}>
                    <strong className={css.cardTitle}>{group.providerName}</strong>
                    <span className={css.providerMeta}>
                      <span>{group.provider}</span>
                      <span className={css.tag}>{group.models.length} {t('models')}</span>
                      {wrapped > 0 ? <span className={css.tag} data-kind="active">{wrapped} {t('wrapTag')}</span> : null}
                      <span aria-hidden="true">{open ? '−' : '+'}</span>
                    </span>
                  </button>
                  {open ? (
                    <div className={css.models}>
                      {group.models.map(entry => {
                        const key = targetKey(group.provider, entry.id)
                        return (
                          <label className={css.modelRow} key={entry.id}>
                            <input
                              type="checkbox"
                              disabled={entry.nativeVision || saving || testing}
                              checked={entry.nativeVision || enabled[key] === true}
                              onChange={event => { const checked = event.currentTarget.checked; setEnabled(current => ({ ...current, [key]: checked })) }}
                            />
                            <span className={css.modelName}>{entry.name}</span>
                            <span className={css.tag}>{entry.nativeVision ? t('nativeTag') : t('wrapTag')}</span>
                          </label>
                        )
                      })}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <div className={css.settingsFooter}>
            {notice !== null ? <p className={css.footerNotice} data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : undefined}>{notice.message}</p> : <span className={css.footerNotice} />}
            <div className={css.settingsFooterActions}>
              <button className={css.settingsSecondaryButton} type="button" disabled={saving || testing || provider.length === 0 || model.length === 0} onClick={() => { void test() }}>{testing ? t('testing') : t('test')}</button>
              <button className={css.settingsSecondaryButton} type="button" disabled={saving || testing || !dirty} onClick={cancel}>{t('cancel')}</button>
              <button className={css.settingsPrimaryButton} type="submit" disabled={saving || testing || !dirty || provider.length === 0 || model.length === 0}>{saving ? t('saving') : t('save')}</button>
            </div>
          </div>
        </form>
      ) : null}
    </section>
  )
}

function targetKey(provider: string, model: string): string {
  return `${provider}\0${model}`
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
