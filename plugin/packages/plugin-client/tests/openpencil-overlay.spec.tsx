// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/openpencil/sdk-editor.ts', () => ({
  mountOpenPencilSDK: vi.fn().mockRejectedValue(new Error('SDK initialization failed')),
}))

import {
  OpenPencilController,
  OpenPencilOverlay,
  type OpenPencilRemote,
} from '../src/client/openpencil/OpenPencilIntegration.tsx'

afterEach(cleanup)

describe('OpenPencil overlay', () => {
  it('can be closed when SDK initialization fails', async () => {
    const visible = {
      bundled: true,
      running: true,
      owned: true,
      port: 31415,
      phase: 'active' as const,
      mcpConnected: true,
      toolCount: 91,
      visible: true,
      revision: 1,
    }
    const hide = vi.fn().mockResolvedValue({ ok: true, value: { ...visible, visible: false, revision: 2 } })
    const remote = {
      snapshot: vi.fn().mockResolvedValue({ ok: true, value: visible }),
      show: vi.fn().mockResolvedValue({ ok: true, value: visible }),
      hide,
      connection: vi.fn().mockResolvedValue({ ok: true, value: { port: 31415, authToken: 'test-token' } }),
      canvasKitWasm: vi.fn().mockResolvedValue({ ok: true, value: 'AA==' }),
      fontAsset: vi.fn(),
      startCollaboration: vi.fn(),
      stopCollaboration: vi.fn(),
      readDesignFile: vi.fn(),
      writeDesignFile: vi.fn(),
    } as unknown as OpenPencilRemote
    const controller = new OpenPencilController(remote)

    render(
      <OpenPencilOverlay
        controller={controller}
        useSessions={selector => selector({ current: 'session-1' } as never)}
      />,
    )

    expect(await screen.findByText('SDK initialization failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭设计画布' }))
    await waitFor(() => { expect(hide).toHaveBeenCalledOnce() })
    controller.dispose()
  })
})
