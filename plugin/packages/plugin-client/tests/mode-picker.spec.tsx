// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPresetLabelProps, AgentPresetSeatProps, AgentPresetSeatState } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { hideLegacyPresetCards, ModePicker, SessionPresetLabel } from '../src/client/design/mode-picker.tsx'

afterEach(cleanup)

it('hides the legacy design label without rewriting the session or hiding other presets', () => {
  const state = { byId: {
    legacy: { projectionValues: { agentPreset: 'design' } },
    normal: { projectionValues: { agentPreset: 'standard' } },
  } }
  const props = {
    sessionId: 'legacy',
    useSessions: (selector: (value: typeof state) => unknown) => selector(state),
  } as unknown as AgentPresetLabelProps
  const OfficialLabel = vi.fn(() => <span>Standard preset</span>)
  const view = render(<SessionPresetLabel {...props} component={OfficialLabel} />)
  expect(view.container.textContent).toBe('')
  expect(OfficialLabel).not.toHaveBeenCalled()
  expect(state.byId.legacy.projectionValues.agentPreset).toBe('design')
  view.rerender(<SessionPresetLabel {...props} sessionId={'normal' as AgentPresetLabelProps['sessionId']} component={OfficialLabel} />)
  expect(screen.getByText('Standard preset')).toBeTruthy()
  view.rerender(<SessionPresetLabel {...props} component={OfficialLabel} />)
  expect(view.container.textContent).toBe('')
})

it('filters mode choices while preserving the official selection action and live state', () => {
  let state: AgentPresetSeatState = {
    current: 'standard', busy: false, error: null, introduce: false,
    options: ['standard', 'minimal', 'ptc', 'cordis', 'design', 'custom'].map(id => ({ id, trust: 'system' as const })),
  }
  const notify = new Set<() => void>()
  const subscribe = (fn: () => void) => { notify.add(fn); return () => { notify.delete(fn) } }
  const select = vi.fn(async (id: string) => { state = { ...state, current: id }; notify.forEach(fn => fn()); return undefined })
  const useAgentPresetSeat: AgentPresetSeatProps['useAgentPresetSeat'] = selector => selector(useSyncExternalStore(subscribe, () => state))
  function OfficialSeat(props: AgentPresetSeatProps) {
    const snapshot = props.useAgentPresetSeat(value => value)
    return <><output>{snapshot.current}</output>{snapshot.options.map(option => <button key={option.id} onClick={() => void props.select(option.id)}>{option.id}</button>)}</>
  }
  render(<ModePicker component={OfficialSeat} {...{ useAgentPresetSeat, select } as AgentPresetSeatProps} />)
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['standard', 'minimal', 'ptc', 'cordis', 'custom'])
  act(() => fireEvent.click(screen.getByRole('button', { name: 'minimal' })))
  expect(select).toHaveBeenCalledExactlyOnceWith('minimal')
  expect(screen.getByRole('status').textContent).toBe('minimal')
  expect(state.options).toHaveLength(6)
})

it('hides only the design card as the official settings section mounts, and restores it on disposal', async () => {
  const stop = hideLegacyPresetCards(document.body)
  const choose = vi.fn()
  const view = render(<section data-slot="settings.section"><ul>
    {['standard', 'minimal', 'ptc', 'cordis', 'design', 'custom'].map(id =>
      <li key={id}><button aria-pressed={false} onClick={() => choose(id)}><code>{id}</code></button></li>)}
  </ul><code>design</code></section>)
  try {
    await waitFor(() => expect(view.container.querySelectorAll('[data-starweave-retired-preset]')).toHaveLength(1))
    expect(view.container.querySelector('[data-starweave-retired-preset]')?.textContent).toBe('design')
    expect(view.container.querySelectorAll('button')).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: 'custom' }))
    expect(choose).toHaveBeenCalledExactlyOnceWith('custom')
  } finally { stop() }
  expect(view.container.querySelector('[data-starweave-retired-preset]')).toBeNull()
})
