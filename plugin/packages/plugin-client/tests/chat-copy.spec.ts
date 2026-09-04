import { describe, expect, it } from 'vitest'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
import {
  CHAT_DEEP_DIVING_KEY, installChatCopy, STARWEAVE_DEEP_DIVING_COPY,
} from '../src/client/chat-copy.ts'

class FakeLocale {
  active = 'zh'
  revision = 0

  bind = (namespace: string): Translate => (key: string) => `${namespace}:${key}`

  getLocale(): { active: string } {
    return { active: this.active }
  }

  register(): () => void {
    this.revision += 1
    return () => { this.revision += 1 }
  }
}

describe('installChatCopy', () => {
  it('replaces only the Chinese Chat running copy', () => {
    const locale = new FakeLocale()
    const dispose = installChatCopy(locale)
    const chat = locale.bind('chat')

    expect(chat(CHAT_DEEP_DIVING_KEY)).toBe(STARWEAVE_DEEP_DIVING_COPY)
    expect(chat('chat.send')).toBe('chat:chat.send')
    expect(locale.bind('settings')('chat.deepDiving')).toBe('settings:chat.deepDiving')

    locale.active = 'en'
    expect(chat(CHAT_DEEP_DIVING_KEY)).toBe('chat:chat.deepDiving')

    dispose()
    expect(locale.bind('chat')(CHAT_DEEP_DIVING_KEY)).toBe('chat:chat.deepDiving')
  })

  it('publishes locale revisions after installation and disposal', () => {
    const locale = new FakeLocale()
    const dispose = installChatCopy(locale)

    expect(locale.revision).toBe(1)
    dispose()
    expect(locale.revision).toBe(2)
  })
})
