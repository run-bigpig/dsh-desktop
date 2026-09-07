// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesignSurface, type DesignConnection } from '../src/client/design/DesignConversationView.tsx'
import type { CanvasResources } from '../src/client/design/canvas-resources.ts'

afterEach(cleanup)

it('attaches only while visible and releases the view on session remount', async () => {
  const connection = { sessionId: 'a' } as DesignConnection
  const connect = vi.fn(async () => connection)
  const detach = vi.fn()
  const attach = vi.fn(() => ({ ready: Promise.resolve(), detach }))
  const resources = { attach } as unknown as CanvasResources
  const view = render(<DesignSurface connect={connect} resources={resources} visible />)
  await waitFor(() => expect(attach).toHaveBeenCalledOnce())
  view.rerender(<DesignSurface connect={connect} resources={resources} visible={false} />)
  expect(detach).toHaveBeenCalledOnce()
  expect(document.querySelector('[data-starweave-design-layout]')).toBeNull()
  view.rerender(<DesignSurface connect={connect} resources={resources} visible />)
  await waitFor(() => expect(attach).toHaveBeenCalledTimes(2))
  view.unmount()
  expect(detach).toHaveBeenCalledTimes(2)
})
