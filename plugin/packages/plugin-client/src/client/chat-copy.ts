import type { Translate } from '@deepseek-ai/dsh-client-locale/client'

export const CHAT_DEEP_DIVING_KEY = 'chat.deepDiving'
export const STARWEAVE_DEEP_DIVING_COPY = '星织万物中...'

const CHAT_NAMESPACE = 'chat'
const REFRESH_NAMESPACE = 'desktop.chat-copy-refresh'

interface LocaleBridge {
  bind: (namespace: string) => Translate
  getLocale: () => { active: string }
  register: (namespace: string, locale: string, dict: Record<string, string>) => () => void
}

/** Override the Chinese Chat running copy through the public Locale service. */
export function installChatCopy(locale: LocaleBridge): () => void {
  const previousBind = locale.bind
  const decoratedBind: LocaleBridge['bind'] = (namespace) => {
    const translate = previousBind.call(locale, namespace)
    if (namespace !== CHAT_NAMESPACE) return translate
    return (key, params) => {
      if (key === CHAT_DEEP_DIVING_KEY && locale.getLocale().active === 'zh') {
        return STARWEAVE_DEEP_DIVING_COPY
      }
      return translate(key, params)
    }
  }

  locale.bind = decoratedBind
  const disposeRefresh = locale.register(REFRESH_NAMESPACE, 'zh', {})

  return () => {
    if (locale.bind === decoratedBind) locale.bind = previousBind
    disposeRefresh()
  }
}
