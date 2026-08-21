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
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
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
      setBaseURL(value.vision.baseURL)
      setModel(value.vision.model)
      setApiKey('')
      setHasApiKey(value.vision.hasApiKey)
      setEnabled(Object.fromEntries(value.targets.map(target => [targetKey(target.provider, target.model), target.enabled])))
    }, () => { if (current) setState({ status: 'error' }) })
    return () => { current = false }
  }, [snapshot, request])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (state.status !== 'ready') return
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
          baseURL: baseURL.trim(),
          model: model.trim(),
          ...(apiKey.length === 0 ? {} : { apiKey }),
        },
        targets,
      })
      setApiKey('')
      setNotice({ kind: 'ok', message: t('saved') })
      setRequest(value => value + 1)
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
        baseURL: baseURL.trim(),
        model: model.trim(),
        ...(apiKey.length === 0 ? {} : { apiKey }),
      }))
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('saveFailed') })
    } finally {
      setTesting(false)
    }
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
            <p className={css.hint}>{t('endpointHint')}</p>
            <div className={css.formGrid}>
              <div className={css.field} data-wide="true">
                <label htmlFor={`${formId}-base-url`}>{t('baseURL')}</label>
                <input id={`${formId}-base-url`} type="url" required placeholder="https://api.siliconflow.cn/v1" value={baseURL} onChange={event => { setBaseURL(event.currentTarget.value) }} />
              </div>
              <div className={css.field}>
                <label htmlFor={`${formId}-model`}>{t('model')}</label>
                <input id={`${formId}-model`} required placeholder="Qwen/Qwen3-VL-32B-Instruct" value={model} onChange={event => { setModel(event.currentTarget.value) }} />
              </div>
              <div className={css.field}>
                <label htmlFor={`${formId}-api-key`}>{t('apiKey')}</label>
                <input id={`${formId}-api-key`} type="password" autoComplete="off" value={apiKey} onChange={event => { setApiKey(event.currentTarget.value) }} />
                <p className={css.hint}>{hasApiKey ? t('apiKeySet') : t('apiKeyMissing')} · {t('apiKeyHint')}</p>
              </div>
            </div>
          </div>

          <div className={css.toolbar}>
            <div className={css.heading}><h3>{t('targets')}</h3></div>
          </div>
          <p className={css.hint}>{t('targetsHint')}</p>
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
                              disabled={entry.nativeVision}
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
          {notice !== null ? <p className={css.notice} data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : undefined}>{notice.message}</p> : null}
          <div className={css.buttonGroup}>
            <button className={css.primaryButton} type="submit" disabled={saving || testing}>{saving ? t('saving') : t('save')}</button>
            <button className={css.button} type="button" disabled={saving || testing} onClick={() => { void test() }}>{testing ? t('testing') : t('test')}</button>
          </div>
        </form>
      ) : null}
    </section>
  )
}

function targetKey(provider: string, model: string): string {
  return `${provider}\0${model}`
}
