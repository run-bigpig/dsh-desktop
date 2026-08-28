// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MarketplaceSettingsTab,
  type MarketplaceSettingsTabProps,
} from '../src/client/marketplace/MarketplaceSettingsTab.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe('marketplace settings operation state', () => {
  it('restores an active backend operation after the settings tab is remounted', async () => {
    const activeOperation = vi.fn().mockResolvedValue({
      id: 'operation-id',
      pluginId: 'dream-skin',
      action: 'install',
      phase: 'installing',
      progress: 60,
      message: 'Installing plugin',
      error: null,
    })
    const props = {
      catalog: vi.fn().mockResolvedValue({
        plugins: [{
          id: 'dream-skin',
          name: 'Dream Skin',
          description: 'Harness theme',
          publisher: 'RevolutionLA',
          packageName: 'dsh-dream-skin',
          repositoryURL: 'https://github.com/RevolutionLA/dsh-dream-skin',
          version: '1.0.0',
          installedVersion: null,
          updateAvailable: false,
          permissions: [],
          license: 'MIT',
        }],
        catalogVerified: true,
        generatedAt: '2026-08-20T00:00:00Z',
        warning: null,
      }),
      mutate: vi.fn(),
      activeOperation,
      operation: vi.fn(),
      t: (key: keyof typeof en) => en[key],
    } as unknown as MarketplaceSettingsTabProps

    const firstView = render(<MarketplaceSettingsTab {...props} />)
    expect(await screen.findByText('Installing plugin')).toBeTruthy()
    firstView.unmount()

    render(<MarketplaceSettingsTab {...props} />)
    expect(await screen.findByText('Installing plugin')).toBeTruthy()
    await waitFor(() => { expect(activeOperation).toHaveBeenCalledTimes(2) })
    expect((screen.getByRole('button', { name: '60%' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not offer an older catalog release as an update', async () => {
    const props = {
      catalog: vi.fn().mockResolvedValue({
        plugins: [{
          id: 'dream-skin',
          name: 'Dream Skin',
          description: 'Harness theme',
          publisher: 'RevolutionLA',
          packageName: 'dsh-dream-skin',
          repositoryURL: 'https://github.com/RevolutionLA/dsh-dream-skin',
          version: '1.0.0',
          installedVersion: '1.1.0',
          updateAvailable: false,
          permissions: [],
          license: 'MIT',
        }],
        catalogVerified: true,
        generatedAt: '2026-08-20T00:00:00Z',
        warning: null,
      }),
      mutate: vi.fn(),
      activeOperation: vi.fn().mockResolvedValue(null),
      operation: vi.fn(),
      t: (key: keyof typeof en) => en[key],
    } as unknown as MarketplaceSettingsTabProps

    render(<MarketplaceSettingsTab {...props} />)
    expect(await screen.findByRole('button', { name: en.uninstall })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.update })).toBeNull()
  })
})
