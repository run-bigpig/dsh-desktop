// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpSettingsTab, type McpSettingsTabProps } from '../src/client/McpSettingsTab.tsx'
import { VisionSettingsTab, type VisionSettingsTabProps } from '../src/client/VisionSettingsTab.tsx'
import { mcpEn, visionEn } from '../src/client/locales.ts'

afterEach(cleanup)

describe('integration settings controls', () => {
  it('keeps the MCP editor mounted while controlled fields change', async () => {
    const props = {
      list: vi.fn().mockResolvedValue({ servers: [] }),
      upsert: vi.fn(),
      remove: vi.fn(),
      t: (key: keyof typeof mcpEn) => mcpEn[key],
    } as unknown as McpSettingsTabProps
    render(<McpSettingsTab {...props} />)

    expect(await screen.findByText(mcpEn.empty)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: mcpEn.add }))

    const name = screen.getByRole('textbox', { name: mcpEn.serverName }) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'local-tools' } })
    expect(name.value).toBe('local-tools')

    const enabled = screen.getByRole('checkbox', { name: mcpEn.enabled }) as HTMLInputElement
    expect(enabled.checked).toBe(true)
    fireEvent.click(enabled)
    expect(enabled.checked).toBe(false)
    expect(screen.getByRole('heading', { name: mcpEn.add })).toBeTruthy()
  })

  it('keeps the Vision tab mounted while wrapped vision is toggled', async () => {
    const props = {
      snapshot: vi.fn().mockResolvedValue({
        vision: { baseURL: '', model: '', hasApiKey: false },
        targets: [],
        catalog: [{
          provider: 'deepseek-official',
          providerName: 'DeepSeek',
          models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', nativeVision: false }],
        }],
      }),
      save: vi.fn(),
      testConnection: vi.fn(),
      t: (key: keyof typeof visionEn) => visionEn[key],
    } as unknown as VisionSettingsTabProps
    render(<VisionSettingsTab {...props} />)

    expect(await screen.findByRole('heading', { name: visionEn.endpoint })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek/ }))

    const wrapped = screen.getByRole('checkbox', { name: /DeepSeek V4 Flash/ }) as HTMLInputElement
    expect(wrapped.checked).toBe(false)
    fireEvent.click(wrapped)
    expect(wrapped.checked).toBe(true)
    expect(screen.getByRole('heading', { name: visionEn.targets })).toBeTruthy()
  })
})
