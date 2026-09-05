import { useEffect, useId, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export const OPENAI_BASE_URL = 'http://10.225.40.100:3000/v1'
export const OPENAI_CREDENTIAL = 'STARWEAVE_OPENAI_API_KEY'
const en = {
  title: 'Set up OpenAI', description: 'Enter your API key for this endpoint. You can also configure it later in Settings → Models.',
  key: 'API Key', save: 'Save', saving: 'Saving…', later: 'Later', retry: 'Retry',
  invalid: 'Enter a non-empty API key using printable ASCII characters without spaces.',
  failed: 'Unable to access credentials. Please retry or use Settings → Models.',
  readonly: 'Credentials are read-only. Configure the key in your Harness environment.',
}
const zh: Record<keyof typeof en, string> = {
  title: '配置 OpenAI', description: '请输入此接口的 API Key，也可稍后在「设置 → 模型」中配置。',
  key: 'API Key', save: '保存', saving: '保存中…', later: '稍后填写', retry: '重试',
  invalid: '请输入非空的 API Key，仅支持不含空格的可打印 ASCII 字符。',
  failed: '无法读取或保存凭据，请重试，或前往「设置 → 模型」配置。',
  readonly: '当前凭据为只读，请在 Harness 环境中配置密钥。',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'desktop.openaiOnboarding': keyof typeof en }
}
export interface OpenAIOnboardingInjected {
  inspect: () => Promise<'skip' | 'prompt' | 'readonly'>
  save: (key: string) => Promise<void>
}
type Props = PropsRuntime<'settings.onboarding'> & PropsLocale<'desktop.openaiOnboarding'> & OpenAIOnboardingInjected

export function OpenAIOnboarding({ inspect, save, complete, t }: Props) {
  const [state, setState] = useState<'loading' | 'prompt' | 'readonly' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'invalid' | 'failed' | null>(null)
  const saving = useRef(false)
  const inputId = useId()
  useEffect(() => {
    let active = true
    setState('loading')
    void inspect().then(result => {
      if (!active) return
      if (result === 'skip') complete()
      else setState(result)
    }, () => { if (active) setState('error') })
    return () => { active = false }
  }, [inspect, complete, attempt])
  const visible = state !== 'loading'
  useEffect(() => {
    if (!visible) return
    const root = document.getElementById('root')
    if (!root) return
    const previous = root.inert
    root.inert = true
    return () => { root.inert = previous }
  }, [visible])
  const close = () => { if (!saving.current) { setKey(''); complete() } }
  const submit = async () => {
    if (saving.current) return
    const value = key.trim()
    if (!/^[\x21-\x7e]+$/.test(value)) { setError('invalid'); return }
    saving.current = true
    setBusy(true)
    setError(null)
    try { await save(value); setKey(''); complete() }
    catch { setError('failed') }
    finally { saving.current = false; setBusy(false) }
  }
  return <Modal open={visible} title={t('title')} description={t('description')} closeLabel={t('later')} onClose={close}
    footer={<><Button disabled={busy} onClick={close}>{t('later')}</Button>
      {state === 'error' && <Button onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>}
      {state === 'prompt' && <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>{t(busy ? 'saving' : 'save')}</Button>}</>}>
    <p style={{ overflowWrap: 'anywhere' }}>Base URL: {OPENAI_BASE_URL}</p>
    {state === 'prompt' && <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <label htmlFor={inputId}>{t('key')}</label>
      <input id={inputId} type="password" autoFocus autoComplete="off" spellCheck={false} value={key} disabled={busy}
        aria-invalid={error === 'invalid'} aria-describedby={error ? `${inputId}-error` : undefined}
        style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '10px', marginTop: '8px' }}
        onChange={event => { setKey(event.target.value); setError(null) }} />
    </form>}
    {(error || state === 'error' || state === 'readonly') && <p id={`${inputId}-error`} role="alert">{t(error ?? (state === 'readonly' ? 'readonly' : 'failed'))}</p>}
  </Modal>
}

export function applyOpenAIOnboarding(ctx: Context) {
  ctx.effect(() => ctx.locale.register('desktop.openaiOnboarding', { en, zh }), 'desktop-openai: dictionaries')
  ctx.inject(['remote.settings', 'remote.credentials'], inner => {
    const injected: OpenAIOnboardingInjected = {
      inspect: async () => {
        const settings = await inner.remote.settings.describe()
        if (!settings.ok) throw new Error('OpenAI settings unavailable')
        const value = settings.value.namespaces.find(entry => entry.ns === 'llm-pi-ai')?.value as
          { providers?: { openai?: { baseURL?: string; apiKeyEnv?: string } } } | undefined
        const provider = value?.providers?.openai
        if (provider?.baseURL !== OPENAI_BASE_URL || provider.apiKeyEnv !== OPENAI_CREDENTIAL) return 'skip'
        const credentials = await inner.remote.credentials.describe([OPENAI_CREDENTIAL])
        if (!credentials.ok || !credentials.value[OPENAI_CREDENTIAL]) throw new Error('OpenAI credentials unavailable')
        const info = credentials.value[OPENAI_CREDENTIAL]
        return info.configured ? 'skip' : info.writable ? 'prompt' : 'readonly'
      },
      save: async key => {
        const result = await inner.remote.credentials.set(OPENAI_CREDENTIAL, key)
        if (!result.ok) throw new Error('OpenAI credential save failed')
      },
    }
    inner.slots.inject('settings.onboarding', () => inner.slots.register({
      name: 'settings.onboarding', id: 'desktop-openai', order: -50,
      locale: 'desktop.openaiOnboarding', inject: () => injected,
    }, OpenAIOnboarding))
  })
}
