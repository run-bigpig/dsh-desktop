// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ThinkingDataSettingsSection, type ThinkingDataSettingsProps,
} from '../src/client/thinkingdata/ThinkingDataSettingsSection.tsx'
import { thinkingDataZh } from '../src/client/locales.ts'

afterEach(cleanup)

function props(overrides: Partial<ThinkingDataSettingsProps> = {}): ThinkingDataSettingsProps {
  return {
    snapshot: vi.fn().mockResolvedValue({
      enabled: false,
      url: '',
      effectiveUrl: 'http://10.225.40.100:13360/mcp',
      tokenConfigured: false,
      phase: 'disabled',
    }),
    save: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ ok: true, status: 'ready' }),
    t: key => thinkingDataZh[key],
    ...overrides,
  } as ThinkingDataSettingsProps
}

describe('ThinkingData settings section', () => {
  it('uses the default URL as a placeholder and keeps MCP terminology out of the page', async () => {
    render(<ThinkingDataSettingsSection {...props()} />)
    const url = await screen.findByRole('textbox', { name: thinkingDataZh.url }) as HTMLInputElement
    expect(url.value).toBe('')
    expect(url.placeholder).toBe('http://10.225.40.100:13360/mcp')
    expect(document.body.textContent).not.toContain('MCP')
    expect(screen.queryByText(/工具数量/)).toBeNull()
  })

  it('saves only a non-empty replacement Token and allows testing an unsaved Token', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const testConnection = vi.fn().mockResolvedValue({ ok: true, status: 'ready' })
    render(<ThinkingDataSettingsSection {...props({ save, testConnection })} />)
    await screen.findByRole('textbox', { name: thinkingDataZh.url })
    const enabled = screen.getByRole('switch', { name: /启用数数服务/ })
    expect(enabled.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(enabled)
    expect(enabled.getAttribute('aria-checked')).toBe('true')
    fireEvent.change(screen.getByLabelText(thinkingDataZh.token), { target: { value: 'secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: thinkingDataZh.test }))
    await waitFor(() => expect(testConnection).toHaveBeenCalledWith({ url: '', token: 'secret-token' }))
    fireEvent.click(screen.getByRole('button', { name: thinkingDataZh.save }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true, url: '', token: 'secret-token' }))
  })
})
