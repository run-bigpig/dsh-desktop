// @vitest-environment jsdom
// Gate probe: mount official plugins, never copy or replace their implementation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { useEffect } from 'react'
import { SlotTestRuntime, TestRemote, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as themeApply, inject as themeInject } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply as layoutApply, inject as layoutInject } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply as conversationApply, inject as conversationInject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as chatApply, inject as chatInject } from '@deepseek-ai/dsh-client-ui-chat/client'
import { apply as toolApply, inject as toolInject } from '@deepseek-ai/dsh-client-ui-tool/client'
import { apply as trajectoryApply, inject as trajectoryInject } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'

usePinnedBrowserLanguages('en-US')
const runtimes: SlotTestRuntime[] = []

beforeEach(() => {
  localStorage.clear()
  window.innerWidth = 1920
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  cleanup()
  vi.unstubAllGlobals()
})

function toolEvents(callId: string, output: string): SessionLiveEventEntry[] {
  const entries = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'probe_tool', arguments: '{"path":"sample.txt"}' } },
    { type: 'tool/result', data: {
      turn: 1, step: 1,
      message: { id: `result-${callId}`, role: 'user', source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: output }], isError: false }] },
    }, surfaceOp: 'append' },
  ]
  return entries.map((entry, index) => ({ type: 'event', event: {
    ...entry, seq: SessionSeq(index + 1), time: (index + 1) * 1000,
  } })) as SessionLiveEventEntry[]
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  new TestRemote(runtime.ctx, { session: {
    openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })),
  } })
  runtime.ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  runtime.ctx.provide('uiWorkspace', { connectWorkspace: vi.fn() } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({ id: 'probe-one', summary: { cwd: '/probe', blank: false },
    events: toolEvents('call-one', 'first output') })
  await runtime.mount({ inject: [...themeInject], apply: themeApply })
  await runtime.mount({ inject: [...layoutInject], apply: layoutApply })
  await runtime.mount({ inject: [...conversationInject], apply: conversationApply })
  await runtime.mount({ inject: [...chatInject], apply: chatApply })
  await runtime.mount({ inject: [...toolInject], apply: toolApply })
  await runtime.mount({ inject: [...trajectoryInject], apply: trajectoryApply })
  const view = runtime.renderRoot()
  const details = () => view.container.querySelector<HTMLElement>('[data-slot="details"]')!
  const inspect = (callId: string) => {
    const row = view.container.querySelector<HTMLElement>(`[data-chat-call-id="${callId}"]`)!
    fireEvent.click(row.querySelector('[data-expandable]')!)
    fireEvent.click(within(row).getByRole('button', { name: 'Inspect' }))
  }
  return { runtime, view, details, inspect }
}

// Test-runtime store inspection below is evidence, not a proposed product API.
function selection(runtime: SlotTestRuntime, sessionId: string) {
  const instance = runtime.storeOf('conversation.view', sessionId)
  return (instance.store.getSnapshot() as { selection: unknown }).selection
}

describe('pinned Harness details gate', () => {
  it('remounts the details occupant across session switches and blank sessions', async () => {
    const b = await bench()
    const mount = vi.fn()
    const unmount = vi.fn()
    await b.runtime.mount({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('details', () => ctx.slots.register({ name: 'details', priority: -100 }, () => {
        useEffect(() => { mount(); return unmount }, [])
        return <div>Persistent workspace</div>
      }))
    } })
    await b.runtime.sessions.add({ id: 'probe-two', summary: { cwd: '/other', blank: false } })
    await act(async () => { b.runtime.sessions.open('probe-one'); await b.runtime.flush() })
    await b.runtime.sessions.add({ id: 'probe-blank', summary: { blank: true } })
    await act(async () => { b.runtime.sessions.open('probe-two'); await b.runtime.flush() })
    expect(mount).toHaveBeenCalledTimes(5)
    expect(unmount).toHaveBeenCalledTimes(4)
    expect(b.details().textContent).toBe('Persistent workspace')
  })

  it('Inspect opens native Trajectory rather than selecting a right-panel tool', async () => {
    const b = await bench()
    b.inspect('call-one')
    expect(b.view.getByRole('tab', { name: 'Trajectory' }).getAttribute('aria-selected')).toBe('true')
    expect(b.view.container.textContent).toContain('first output')
    expect(selection(b.runtime, 'probe-one')).toBeNull()
    act(() => { b.runtime.ctx.layout.openDetails() })
    expect(b.details().textContent).not.toContain('first output')
    expect(b.details().textContent).toContain('Click a tool row')
  })

  it('takeover and release preserve native routing, but release cannot supply the missing selection', async () => {
    const b = await bench()
    const mount = vi.fn()
    const unmount = vi.fn()
    const replacement = await b.runtime.mount({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('details', () => ctx.slots.register({ name: 'details', priority: -100 }, () => {
        useEffect(() => { mount(); return unmount }, [])
        return <div>Probe workbench</div>
      }))
    } })
    b.inspect('call-one')
    expect(b.details().textContent).toBe('Probe workbench')
    expect(b.view.getByRole('tab', { name: 'Trajectory' }).getAttribute('aria-selected')).toBe('true')
    // Shadowing does not release the native registration's child ownership.
    expect(b.runtime.slots.spec('conversation.details.tool')).toMatchObject({ kind: 'single', scope: 'session' })
    act(() => { b.runtime.ctx.layout.openDetails(); b.runtime.ctx.layout.closeDetails() })
    expect(mount).toHaveBeenCalledTimes(1)
    expect(unmount).not.toHaveBeenCalled()
    await replacement.dispose()
    expect(unmount).toHaveBeenCalledTimes(1)
    act(() => { b.runtime.ctx.layout.openDetails() })
    expect(b.details().textContent).not.toContain('first output')
    expect(selection(b.runtime, 'probe-one')).toBeNull()
  })

  it('rejects redeclaring the native tool-details child under a replacement panel', async () => {
    const b = await bench()
    expect(() => b.runtime.slots.register({
      name: 'details', priority: -100,
      children: { 'conversation.details.tool': { kind: 'single', scope: 'session' } },
    }, () => null)).toThrow(/already declared/)
    expect(b.runtime.slots.entriesOfSlot('details')).toHaveLength(1)
  })

  it('keeps tool inspection scoped when changing sessions', async () => {
    const b = await bench()
    b.inspect('call-one')
    await b.runtime.sessions.add({ id: 'probe-two', summary: { cwd: '/other', blank: false },
      events: toolEvents('call-two', 'second output') })
    b.inspect('call-two')
    expect(b.view.container.textContent).toContain('second output')
    expect(b.view.container.textContent).not.toContain('first output')
    await act(async () => { b.runtime.sessions.open('probe-one'); await b.runtime.flush() })
    expect(b.view.container.textContent).toContain('first output')
    expect(b.view.container.textContent).not.toContain('second output')
    expect(selection(b.runtime, 'probe-one')).toBeNull()
  })

  it('keeps official width at 360 by default and clamps the root action to 520', async () => {
    const b = await bench()
    const layout = b.runtime.ctx.layout
    expect('setDetails' in layout).toBe(false)
    expect('setDetailsWidth' in layout).toBe(false)
    const root = b.runtime.storeOf('root') as unknown as {
      actions: { setDetails: (width: number) => void }
      store: { getSnapshot: () => { details: number } }
    }
    act(() => { layout.openDetails() })
    expect(root.store.getSnapshot().details).toBe(360)
    act(() => { root.actions.setDetails(800) })
    expect(root.store.getSnapshot().details).toBe(520)
    expect(b.view.container.querySelector<HTMLElement>('[style*="grid-template-columns"]')?.style.gridTemplateColumns).toContain('520px')
    act(() => { layout.closeDetails(); layout.openDetails() })
    expect(root.store.getSnapshot().details).toBe(360)
  })
})
