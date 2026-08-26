// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpSettingsTab, type McpSettingsTabProps } from '../src/client/McpSettingsTab.tsx'
import { VisionSettingsTab, type VisionSettingsTabProps } from '../src/client/VisionSettingsTab.tsx'
import { ImageSettingsTab, type ImageSettingsTabProps } from '../src/client/ImageSettingsTab.tsx'
import { imageEn, mcpEn, visionEn } from '../src/client/locales.ts'

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
        vision: { provider: '', model: '' },
        targets: [],
        catalog: [{
          provider: 'deepseek-official',
          providerName: 'DeepSeek',
          models: [
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', nativeVision: false },
            { id: 'deepseek-vl', name: 'DeepSeek VL', nativeVision: true },
          ],
        }],
      }),
      save: vi.fn(),
      testConnection: vi.fn(),
      t: (key: keyof typeof visionEn) => visionEn[key],
    } as unknown as VisionSettingsTabProps
    render(<VisionSettingsTab {...props} />)

    expect(await screen.findByRole('heading', { name: visionEn.endpoint })).toBeTruthy()
    const saveButton = screen.getByRole('button', { name: visionEn.save }) as HTMLButtonElement
    const cancelButton = screen.getByRole('button', { name: visionEn.cancel }) as HTMLButtonElement
    expect(screen.getByRole('option', { name: /DeepSeek V4 Flash/ })).toBeTruthy()
    expect(saveButton.disabled).toBe(true)
    expect(cancelButton.disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: visionEn.model }), {
      target: { value: JSON.stringify(['deepseek-official', 'deepseek-vl']) },
    })
    expect((screen.getByRole('combobox', { name: visionEn.model }) as HTMLSelectElement).value)
      .toBe(JSON.stringify(['deepseek-official', 'deepseek-vl']))
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek/ }))

    const wrapped = screen.getByRole('checkbox', { name: /DeepSeek V4 Flash/ }) as HTMLInputElement
    expect(wrapped.checked).toBe(false)
    fireEvent.click(wrapped)
    expect(wrapped.checked).toBe(true)
    expect(saveButton.disabled).toBe(false)
    expect(cancelButton.disabled).toBe(false)
    expect((screen.getByRole('button', { name: visionEn.test }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(cancelButton)
    expect((screen.getByRole('combobox', { name: visionEn.model }) as HTMLSelectElement).value)
      .toBe(JSON.stringify(['', '']))
    expect(wrapped.checked).toBe(false)
    expect(saveButton.disabled).toBe(true)
    expect(cancelButton.disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: visionEn.model }), {
      target: { value: JSON.stringify(['deepseek-official', 'deepseek-vl']) },
    })
    fireEvent.click(wrapped)
    fireEvent.click(saveButton)
    expect(props.save).toHaveBeenCalledWith({
      vision: { provider: 'deepseek-official', model: 'deepseek-vl' },
      targets: [
        { provider: 'deepseek-official', model: 'deepseek-v4-flash', enabled: true },
        { provider: 'deepseek-official', model: 'deepseek-vl', enabled: false },
      ],
    })
    await waitFor(() => {
      expect(saveButton.disabled).toBe(true)
      expect(cancelButton.disabled).toBe(true)
    })
    expect(screen.getByRole('heading', { name: visionEn.targets })).toBeTruthy()
  })

  it('does not expose retained legacy vision configuration', async () => {
    const props = {
      snapshot: vi.fn().mockResolvedValue({
        vision: { provider: '', model: '' },
        legacyVision: {
          baseURL: 'https://legacy.example/v1',
          model: 'legacy-vl',
          hasApiKey: true,
        },
        targets: [],
        catalog: [],
      }),
      save: vi.fn(),
      testConnection: vi.fn(),
      t: (key: keyof typeof visionEn) => visionEn[key],
    } as unknown as VisionSettingsTabProps
    render(<VisionSettingsTab {...props} />)

    expect(await screen.findByRole('heading', { name: visionEn.endpoint })).toBeTruthy()
    expect(screen.queryByText('https://legacy.example/v1')).toBeNull()
    expect(screen.queryByText('legacy-vl')).toBeNull()
    expect(screen.queryByLabelText(/API key/i)).toBeNull()
  })

  it('selects only image models exposed by the Host adapter catalog', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const props = {
      snapshot: vi.fn().mockResolvedValue({
        image: { provider: '', model: '' },
        catalog: [{
          provider: 'google',
          providerName: 'Google',
          models: [{
            id: 'gemini-3.1-flash-image',
            name: 'Nano Banana 2',
            capabilities: {
              adapter: 'gemini-native-image',
              generate: true,
              edit: true,
              aspectRatios: ['1:1', '16:9'],
              resolutions: ['1K', '2K', '4K'],
            },
          }, {
            id: 'gemini-3.6-flash',
            name: 'Gemini 3.6 Flash',
            capabilities: { adapter: 'gemini-native-image', generate: true, edit: true },
          }],
        }],
      }),
      save,
      t: (key: keyof typeof imageEn) => imageEn[key],
    } as unknown as ImageSettingsTabProps
    render(<ImageSettingsTab {...props} />)

    const select = await screen.findByRole('combobox', { name: imageEn.model })
    const saveButton = screen.getByRole('button', { name: imageEn.save }) as HTMLButtonElement
    const cancelButton = screen.getByRole('button', { name: imageEn.cancel }) as HTMLButtonElement
    expect(screen.getByRole('option', { name: /Gemini 3\.6 Flash/ })).toBeTruthy()
    expect(saveButton.disabled).toBe(true)
    expect(cancelButton.disabled).toBe(true)
    fireEvent.change(select, { target: { value: JSON.stringify(['google', 'gemini-3.1-flash-image']) } })
    expect(screen.getByText('Gemini Native Image')).toBeTruthy()
    expect(saveButton.disabled).toBe(false)
    expect(cancelButton.disabled).toBe(false)
    fireEvent.click(cancelButton)
    expect((select as HTMLSelectElement).value).toBe(JSON.stringify(['', '']))
    expect(saveButton.disabled).toBe(true)
    expect(cancelButton.disabled).toBe(true)
    fireEvent.change(select, { target: { value: JSON.stringify(['google', 'gemini-3.1-flash-image']) } })
    fireEvent.click(saveButton)
    expect(save).toHaveBeenCalledWith({ provider: 'google', model: 'gemini-3.1-flash-image' })
    await waitFor(() => {
      expect(saveButton.disabled).toBe(true)
      expect(cancelButton.disabled).toBe(true)
    })
  })
})
