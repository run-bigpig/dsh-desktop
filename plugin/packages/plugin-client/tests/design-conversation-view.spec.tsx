// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
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

it('keeps the canvas covered until presentation is ready and ignores completion after closing', async () => {
  let finish!: () => void
  const ready = new Promise<void>(resolve => { finish = resolve })
  const connect = vi.fn(async () => ({ sessionId: 'a' }) as DesignConnection)
  const detach = vi.fn()
  const resources = { attach: vi.fn(() => ({ ready, detach })) } as unknown as CanvasResources
  const view = render(<DesignSurface connect={connect} resources={resources} visible />)
  await waitFor(() => expect(resources.attach).toHaveBeenCalledOnce())
  expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('true')
  view.rerender(<DesignSurface connect={connect} resources={resources} visible={false} />)
  await act(async () => { finish(); await ready })
  expect(detach).toHaveBeenCalledOnce()
  expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
  view.rerender(<DesignSurface connect={connect} resources={resources} visible />)
  await waitFor(() => expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false'))
  expect(resources.attach).toHaveBeenCalledTimes(2)
})
