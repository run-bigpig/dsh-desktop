import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  McpServerFiberPhase,
  McpServerUpsertRequest,
  McpServerView,
  McpSettingsSnapshot,
} from '@run-bigpig/dsh-desktop-plugin-host/types'
import type { McpLocaleKey } from './locales.ts'
import css from './IntegrationSettings.module.css'

export interface McpSettingsTabInjected {
  list: () => Promise<McpSettingsSnapshot>
  upsert: (request: McpServerUpsertRequest) => Promise<void>
  remove: (serverName: string) => Promise<void>
}

export type McpSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.mcp'>
  & InjectFace<McpSettingsTabInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: McpSettingsSnapshot }

type Draft = {
  serverName: string
  enabled: boolean
  transport: 'stdio' | 'streamable-http'
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
}

type Editor = null | 'create' | { serverName: string }

const EMPTY_DRAFT: Draft = {
  serverName: '', enabled: true, transport: 'stdio', command: '', argsText: '', envText: '', url: '', headersText: '',
}
const SETTLING = new Set<McpServerFiberPhase>(['pending', 'loading', 'unloading'])
const PHASE_KEYS = {
  pending: 'pending', loading: 'loadingPhase', active: 'active', failed: 'failed', unloading: 'unloading',
} satisfies Record<Exclude<McpServerFiberPhase, null>, McpLocaleKey>

export function McpSettingsTab({ list, upsert, remove, t }: McpSettingsTabProps): ReactNode {
  const formId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [editing, setEditing] = useState<Editor>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [formError, setFormError] = useState<McpLocaleKey | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    let timer: number | undefined
    let ready = false
    const pull = (): void => {
      void list().then(snapshot => {
        if (!current) return
        ready = true
        setState({ status: 'ready', snapshot })
        if (snapshot.servers.some(server => server.enabled && SETTLING.has(server.fiberPhase))) {
          timer = window.setTimeout(pull, 400)
        }
      }, () => {
        if (!current) return
        if (ready) timer = window.setTimeout(pull, 400)
        else setState({ status: 'error' })
      })
    }
    pull()
    return () => { current = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [list, request])

  const reload = (): void => {
    setEditing(null)
    setDraft(EMPTY_DRAFT)
    setFormError(null)
    setPendingDelete(null)
    setRequest(value => value + 1)
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      await upsert(toRequest(draft, editing !== null && editing !== 'create' ? editing.serverName : undefined))
      reload()
    } catch (error) {
      setFormError(error instanceof Error && error.message === 'invalid-kv' ? 'invalidKv' : 'saveFailed')
    } finally {
      setSaving(false)
    }
  }

  const destroy = async (serverName: string): Promise<void> => {
    setRemoving(true)
    setFormError(null)
    try {
      await remove(serverName)
      reload()
    } catch {
      setFormError('removeFailed')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <section className={css.section} aria-busy={state.status === 'loading' || saving || removing}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button className={css.button} type="button" onClick={() => { setState({ status: 'loading' }); setRequest(value => value + 1) }}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <div className={css.toolbar}>
            <div className={css.heading}><h3>{t('catalog')}</h3><span>{state.snapshot.servers.length}</span></div>
            <button className={css.primaryButton} type="button" onClick={() => { setEditing('create'); setDraft(EMPTY_DRAFT); setFormError(null) }}>
              {t('add')}
            </button>
          </div>
          {state.snapshot.servers.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          <ul className={css.serverCards}>
            {state.snapshot.servers.map(server => (
              <li className={css.serverCard} key={`${server.origin}:${server.serverName}`}>
                <div className={css.serverIdentity}>
                  <strong>{server.serverName}</strong>
                  <span>{server.transport === 'stdio' ? t('transportStdio') : t('transportHttp')}</span>
                </div>
                <p className={css.serverDescription}>
                  {server.origin === 'composition' ? t('compositionHint') : server.transport === 'stdio' ? server.command : server.url}
                </p>
                <div className={css.serverMeta}>
                  <span>{server.toolCount} {t('tools')}</span>
                  {server.envKeys.map(key => <span key={`env:${key}`}>ENV · {key}</span>)}
                  {server.headerKeys.map(key => <span key={`header:${key}`}>HEADER · {key}</span>)}
                </div>
                <div className={css.serverActions}>
                  <span
                    className={css.serverStatus}
                    data-kind={server.fiberPhase === 'active' ? 'active' : server.fiberPhase === 'failed' ? 'failed' : undefined}
                  >
                    <span aria-hidden="true" />
                    {server.enabled ? phaseLabel(server.fiberPhase, t) : t('disabledTag')}
                  </span>
                  {server.origin === 'settings' ? (
                    <div className={css.buttonGroup}>
                      {pendingDelete === server.serverName ? (
                        <>
                          <button className={css.dangerButton} type="button" disabled={removing} onClick={() => { void destroy(server.serverName) }}>
                            {removing ? t('removing') : t('confirmRemove')}
                          </button>
                          <button className={css.button} type="button" disabled={removing} onClick={() => { setPendingDelete(null) }}>{t('cancel')}</button>
                        </>
                      ) : (
                        <>
                          <button className={css.button} type="button" onClick={() => { setEditing({ serverName: server.serverName }); setDraft(draftFrom(server)); setFormError(null) }}>{t('edit')}</button>
                          <button className={css.dangerButton} type="button" onClick={() => { setPendingDelete(server.serverName); setFormError(null) }}>{t('remove')}</button>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {editing !== null ? (
            <form className={css.form} onSubmit={event => { void submit(event) }}>
              <h4>{editing === 'create' ? t('add') : t('edit')}</h4>
              <div className={css.formGrid}>
                <div className={css.field}>
                  <label htmlFor={`${formId}-name`}>{t('serverName')}</label>
                  <input id={`${formId}-name`} required maxLength={32} pattern="[A-Za-z0-9_-]{1,32}" value={draft.serverName} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, serverName: value })) }} />
                </div>
                <div className={css.field}>
                  <label htmlFor={`${formId}-transport`}>{t('transport')}</label>
                  <select id={`${formId}-transport`} value={draft.transport} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, transport: value === 'streamable-http' ? 'streamable-http' : 'stdio' })) }}>
                    <option value="stdio">{t('transportStdio')}</option><option value="streamable-http">{t('transportHttp')}</option>
                  </select>
                </div>
                {draft.transport === 'stdio' ? (
                  <>
                    <div className={css.field} data-wide="true"><label htmlFor={`${formId}-command`}>{t('command')}</label><input id={`${formId}-command`} required value={draft.command} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, command: value })) }} /></div>
                    <div className={css.field}><label htmlFor={`${formId}-args`}>{t('args')}</label><textarea id={`${formId}-args`} value={draft.argsText} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, argsText: value })) }} /></div>
                    <div className={css.field}><label htmlFor={`${formId}-env`}>{t('env')}</label><textarea id={`${formId}-env`} value={draft.envText} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, envText: value })) }} /><p className={css.hint}>{t('secretHint')}</p></div>
                  </>
                ) : (
                  <>
                    <div className={css.field} data-wide="true"><label htmlFor={`${formId}-url`}>{t('url')}</label><input id={`${formId}-url`} type="url" required value={draft.url} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, url: value })) }} /></div>
                    <div className={css.field} data-wide="true"><label htmlFor={`${formId}-headers`}>{t('headers')}</label><textarea id={`${formId}-headers`} value={draft.headersText} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, headersText: value })) }} /><p className={css.hint}>{t('secretHint')}</p></div>
                  </>
                )}
              </div>
              <label className={css.checkRow}><input type="checkbox" checked={draft.enabled} onChange={event => { const checked = event.currentTarget.checked; setDraft(current => ({ ...current, enabled: checked })) }} />{t('enabled')}</label>
              {formError !== null ? <p className={css.notice} data-kind="error" role="alert">{t(formError)}</p> : null}
              <div className={css.buttonGroup}>
                <button className={css.primaryButton} type="submit" disabled={saving}>{t('save')}</button>
                <button className={css.button} type="button" disabled={saving} onClick={reload}>{t('cancel')}</button>
              </div>
            </form>
          ) : null}
          {editing === null && formError !== null ? <p className={css.notice} data-kind="error" role="alert">{t(formError)}</p> : null}
        </>
      ) : null}
    </section>
  )
}

function phaseLabel(phase: McpServerFiberPhase, t: McpSettingsTabProps['t']): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

function draftFrom(server: McpServerView): Draft {
  return {
    ...EMPTY_DRAFT,
    serverName: server.serverName,
    enabled: server.enabled,
    transport: server.transport,
    command: server.transport === 'stdio' ? server.command : '',
    argsText: server.transport === 'stdio' ? server.args.join('\n') : '',
    url: server.transport === 'streamable-http' ? server.url : '',
  }
}

function toRequest(draft: Draft, previousName?: string): McpServerUpsertRequest {
  const rename = previousName !== undefined && previousName !== draft.serverName.trim() ? { fromServerName: previousName } : {}
  if (draft.transport === 'stdio') {
    const env = parseKv(draft.envText)
    return {
      transport: 'stdio', serverName: draft.serverName.trim(), enabled: draft.enabled,
      command: draft.command.trim(), args: draft.argsText.split('\n').map(line => line.trimEnd()).filter(Boolean),
      ...rename, ...(env === undefined ? {} : { env }),
    }
  }
  const headers = parseKv(draft.headersText)
  return {
    transport: 'streamable-http', serverName: draft.serverName.trim(), enabled: draft.enabled,
    url: draft.url.trim(), ...rename, ...(headers === undefined ? {} : { headers }),
  }
}

function parseKv(text: string): Record<string, string> | undefined {
  if (text.trim().length === 0) return undefined
  const result: Record<string, string> = {}
  for (const source of text.split('\n')) {
    const line = source.trim()
    if (line.length === 0) continue
    const equals = line.indexOf('=')
    if (equals <= 0) throw new Error('invalid-kv')
    result[line.slice(0, equals)] = line.slice(equals + 1)
  }
  return result
}
